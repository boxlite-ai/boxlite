//! Configure, inspect, disable, and forward to guest SSH.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use boxlite::{
    BoxliteRuntime, LiteBox, SocketAddress, SshAccount, SshConfig, SshStatus, TunnelOptions,
};
use clap::{Args, Subcommand};

use crate::cli::GlobalFlags;
use crate::commands::network::tunnel::{forward_until_interrupted, parse_socket_address};
use crate::formatter;

#[cfg(test)]
mod tests;

#[derive(Args, Debug)]
pub struct SshArgs {
    #[command(subcommand)]
    pub command: SshCommand,
}

#[derive(Subcommand, Debug)]
pub enum SshCommand {
    /// Replace the complete guest SSH configuration; prints status JSON.
    /// Every accepted configuration disconnects existing SSH clients.
    Configure(ConfigureArgs),
    /// Print guest SSH status JSON without starting the box.
    Status(BoxArgs),
    /// Disable guest SSH without starting the box; prints status JSON.
    Disable(BoxArgs),
    /// Forward a local listener to already enabled guest SSH until Ctrl-C.
    Forward(ForwardArgs),
}

#[derive(Args, Debug)]
pub struct BoxArgs {
    /// Box ID or name
    #[arg(value_name = "BOX")]
    pub target: String,
}

#[derive(Args, Debug)]
pub struct ConfigureArgs {
    /// Box ID or name
    #[arg(value_name = "BOX")]
    pub target: String,

    #[command(flatten)]
    pub source: ConfigSource,
}

#[derive(Args, Debug)]
pub struct ForwardArgs {
    /// Box ID or name
    #[arg(value_name = "BOX")]
    pub target: String,

    /// Bind a local TCP port/address or unix:/absolute/path socket
    #[arg(long, value_name = "ADDRESS", value_parser = parse_socket_address, default_value = "127.0.0.1:0")]
    pub listen: SocketAddress,
}

/// Exactly one source: a complete `SshConfig` JSON file, or one login built
/// from key files.
#[derive(Args, Debug)]
pub struct ConfigSource {
    /// Complete SshConfig JSON file; supports several accounts and CAs
    #[arg(long, value_name = "FILE", required_unless_present = "host_key",
          conflicts_with_all = ["host_key", "login", "authorized_key", "guest_listen"])]
    pub ssh_config: Option<PathBuf>,

    /// Unencrypted OpenSSH host private key file
    #[arg(long, value_name = "FILE", requires_all = ["login", "authorized_key"])]
    pub host_key: Option<PathBuf>,

    /// SSH login accepting the --authorized-key keys
    #[arg(long, value_name = "NAME", requires = "host_key")]
    pub login: Option<String>,

    /// File holding one OpenSSH public key; repeatable
    #[arg(long, value_name = "FILE", requires = "host_key")]
    pub authorized_key: Vec<PathBuf>,

    /// Guest address the SSH server listens on; port 0 lets the guest choose
    #[arg(long, value_name = "ADDRESS", default_value = "0.0.0.0:2222")]
    pub guest_listen: String,
}

impl ConfigSource {
    /// Read the configuration without echoing file contents in errors: they
    /// hold private keys, and serde messages can quote string values.
    fn load(&self) -> Result<SshConfig> {
        if let Some(path) = &self.ssh_config {
            let text = read_file(path, "SSH config")?;
            return serde_json::from_str(&text).map_err(|error| {
                let category = match error.classify() {
                    serde_json::error::Category::Io => "read",
                    serde_json::error::Category::Syntax => "syntax",
                    serde_json::error::Category::Data => "field or type",
                    serde_json::error::Category::Eof => "truncated JSON",
                };
                anyhow!(
                    "invalid SSH config {}: {category} error at line {} column {}",
                    path.display(),
                    error.line(),
                    error.column()
                )
            });
        }
        let (Some(host_key), Some(login)) = (&self.host_key, &self.login) else {
            bail!("pass --ssh-config, or --host-key with --login and --authorized-key");
        };
        Ok(SshConfig {
            listen_address: self.guest_listen.clone(),
            host_private_key: read_file(host_key, "host key")?,
            accounts: vec![SshAccount {
                login: login.clone(),
                authorized_keys: self
                    .authorized_key
                    .iter()
                    .map(|path| read_public_key(path))
                    .collect::<Result<_>>()?,
                ca: None,
            }],
        })
    }
}

fn read_file(path: &Path, kind: &str) -> Result<String> {
    std::fs::read_to_string(path).with_context(|| format!("read {kind} file {}", path.display()))
}

fn read_public_key(path: &Path) -> Result<String> {
    let text = read_file(path, "authorized key")?;
    let mut keys = text.lines().map(str::trim).filter(|line| !line.is_empty());
    match (keys.next(), keys.next()) {
        (Some(key), None) => Ok(key.to_string()),
        _ => bail!(
            "authorized key file {} must contain exactly one public key",
            path.display()
        ),
    }
}

pub async fn execute(args: SshArgs, global: &GlobalFlags) -> Result<()> {
    match args.command {
        SshCommand::Configure(args) => {
            let config = args.source.load()?;
            let (_runtime, sandbox) = find_box(global, &args.target).await?;
            print_status(&sandbox.ssh().configure(config).await?)
        }
        SshCommand::Status(args) => {
            let (_runtime, sandbox) = find_box(global, &args.target).await?;
            print_status(&sandbox.ssh().status().await?)
        }
        SshCommand::Disable(args) => {
            let (_runtime, sandbox) = find_box(global, &args.target).await?;
            print_status(&sandbox.ssh().disable().await?)
        }
        SshCommand::Forward(args) => {
            let (_runtime, sandbox) = find_box(global, &args.target).await?;
            let status = sandbox.ssh().status().await?;
            forward(&sandbox, &status, args.listen).await
        }
    }
}

/// The runtime is returned so it outlives the box handle for the whole command.
async fn find_box(global: &GlobalFlags, target: &str) -> Result<(BoxliteRuntime, LiteBox)> {
    let runtime = global.create_runtime()?;
    let sandbox = runtime
        .get(target)
        .await?
        .ok_or_else(|| anyhow!("No such box: {target}"))?;
    Ok((runtime, sandbox))
}

fn print_status(status: &SshStatus) -> Result<()> {
    println!("{}", formatter::format_json(status)?);
    Ok(())
}

/// Map a guest listener to the address a box tunnel reaches. Tunnels target
/// `GUEST_IP`, so only the IPv4 wildcard or `GUEST_IP` itself is reachable.
fn tunnel_target(listen_address: &str) -> Result<SocketAddr> {
    let address: SocketAddr = listen_address
        .parse()
        .with_context(|| format!("guest SSH listen address {listen_address:?} is not IP:PORT"))?;
    let guest_ip: Ipv4Addr = boxlite::net::constants::GUEST_IP
        .parse()
        .context("BoxLite guest IP constant is invalid")?;
    match address.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() || ip == guest_ip => {
            Ok(SocketAddr::new(guest_ip.into(), address.port()))
        }
        _ => bail!("guest SSH listens on {address}; a tunnel reaches only 0.0.0.0 or {guest_ip}"),
    }
}

/// Forward to the port SSH actually bound, which differs from the
/// configuration when it asked for port 0.
async fn forward(sandbox: &LiteBox, status: &SshStatus, listen: SocketAddress) -> Result<()> {
    if !status.enabled {
        bail!(
            "guest SSH is disabled or the box is not running; enable it with \
             `boxlite ssh configure`"
        );
    }
    let tunnel = sandbox
        .network()
        .tunnel(
            tunnel_target(&status.listen_address)?,
            TunnelOptions::default(),
        )
        .await?;
    forward_until_interrupted(tunnel, listen, |address| {
        eprintln!("SSH host key: {}", status.host_public_key);
        eprintln!("SSH host key fingerprint: {}", status.host_key_fingerprint);
        eprintln!("Connect: {}", connect_hint(address));
    })
    .await
}

/// Unix sockets get a description: quoting a path into ProxyCommand would
/// need two shell layers of escaping.
fn connect_hint(address: &SocketAddress) -> String {
    match address {
        SocketAddress::Tcp(address) => {
            format!("ssh -p {} -l LOGIN {}", address.port(), address.ip())
        }
        SocketAddress::Unix(path) => format!(
            "point an SSH client's transport at Unix socket {} and log in as LOGIN",
            path.display()
        ),
    }
}
