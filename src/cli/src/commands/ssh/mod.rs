//! Configure, inspect, enable, disable, and forward to guest SSH.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use boxlite::{
    BoxTunnel, BoxliteRuntime, LiteBox, SocketAddress, SshAccount, SshConfig, SshStatus,
    TunnelOptions,
};
use clap::{ArgGroup, Args};

use crate::cli::GlobalFlags;
use crate::commands::network::tunnel::{forward_until_interrupted, parse_socket_address};
use crate::formatter;

mod connect;
mod install;
mod proxy;
mod setup;

#[cfg(test)]
mod tests;

#[derive(Args, Debug)]
#[command(group(ArgGroup::new("operation").args(["configure", "status", "enable", "disable", "tunnel", "proxy", "install_ssh_config"])))]
#[command(group(ArgGroup::new("credentials").args(["ssh_config", "host_key"])))]
#[command(group(ArgGroup::new("installation_options")
    .args(["alias", "overwrite"]).multiple(true)
    .requires("install_ssh_config")
    .conflicts_with_all(["configure", "status", "enable", "disable", "tunnel", "proxy"])))]
#[command(group(ArgGroup::new("proxy_target")
    .args(["proxy_local", "proxy_endpoint"])
    .requires("proxy")
    .conflicts_with_all(["configure", "status", "enable", "disable", "tunnel", "install_ssh_config"])))]
pub struct SshArgs {
    /// Box ID or name
    #[arg(value_name = "BOX")]
    pub target: String,

    /// Replace the complete guest SSH configuration; prints status JSON.
    /// Every accepted configuration disconnects existing SSH clients.
    #[arg(long, requires = "credentials")]
    pub configure: bool,

    /// Print guest SSH status JSON without starting the box.
    #[arg(long)]
    pub status: bool,

    /// Enable saved SSH configuration on a running box; prints status JSON.
    #[arg(long)]
    pub enable: bool,

    /// Disable guest SSH on a running box; prints status JSON.
    #[arg(long)]
    pub disable: bool,

    /// Forward a local listener to already enabled guest SSH until Ctrl-C.
    #[arg(long)]
    pub tunnel: bool,

    /// Connect stdin/stdout to enabled guest SSH for OpenSSH ProxyCommand.
    #[arg(long)]
    pub proxy: bool,

    /// Prepare guest SSH and install an alias in your OpenSSH configuration.
    #[arg(long)]
    pub install_ssh_config: bool,

    /// SSH alias to install instead of the box name (or ID for unnamed boxes).
    #[arg(long, value_name = "NAME")]
    pub alias: Option<String>,

    /// Replace a conflicting BoxLite-managed SSH alias, never a handwritten Host.
    #[arg(long)]
    pub overwrite: bool,

    // Generated ProxyCommands need a stable backend without a new context model.
    #[arg(long, hide = true)]
    pub proxy_local: bool,

    #[arg(long, hide = true, value_name = "URL")]
    pub proxy_endpoint: Option<String>,

    #[command(flatten)]
    pub source: ConfigSource,

    /// Bind a local TCP port/address or unix:/absolute/path socket
    #[arg(long, value_name = "ADDRESS", value_parser = parse_socket_address,
          default_value = "127.0.0.1:0", requires = "tunnel",
          conflicts_with_all = ["configure", "status", "enable", "disable", "proxy", "install_ssh_config"])]
    pub listen: SocketAddress,
}

/// Exactly one source: a complete `SshConfig` JSON file, or one login built
/// from key files.
#[derive(Args, Debug)]
#[group(requires = "configure", conflicts_with_all = ["status", "enable", "disable", "tunnel", "proxy", "install_ssh_config"])]
pub struct ConfigSource {
    /// Complete SshConfig JSON file; supports several accounts and CAs
    #[arg(long, value_name = "FILE",
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

/// Dispatch explicit controls or return the default OpenSSH session's exit code.
///
/// Installation shares credential preparation with login but exits without
/// connecting; explicit control operations retain their status/output contracts.
pub async fn execute(args: SshArgs, global: &GlobalFlags) -> Result<i32> {
    if args.configure {
        let config = args.source.load()?;
        let (_runtime, sandbox) = find_box(global, &args.target).await?;
        return print_status(&sandbox.ssh().configure(config).await?).map(|_| 0);
    }
    if args.proxy {
        return proxy::execute(&args, global).await.map(|_| 0);
    }
    if !(args.status || args.enable || args.disable || args.tunnel) {
        return setup::execute(&args, global).await;
    }
    let (_runtime, sandbox) = find_box(global, &args.target).await?;
    let status = if args.enable {
        sandbox.ssh().enable().await?
    } else if args.disable {
        sandbox.ssh().disable().await?
    } else {
        sandbox.ssh().status().await?
    };
    if args.tunnel {
        forward(&sandbox, &status, args.listen).await?;
    } else {
        print_status(&status)?;
    }
    Ok(0)
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
    let tunnel = ssh_tunnel(sandbox, status).await?;
    forward_until_interrupted(tunnel, listen, |address| {
        eprintln!("SSH host key: {}", status.host_public_key);
        eprintln!("SSH host key fingerprint: {}", status.host_key_fingerprint);
        eprintln!("Connect: {}", connect_hint(address));
    })
    .await
}

/// Open forwarding only for an enabled, reachable guest SSH listener.
async fn ssh_tunnel(sandbox: &LiteBox, status: &SshStatus) -> Result<BoxTunnel> {
    if !status.enabled {
        bail!(
            "guest SSH is disabled or the box is not running; enable it with \
             `boxlite ssh BOX`, `boxlite ssh BOX --configure`, or `boxlite ssh BOX --enable`"
        );
    }
    Ok(sandbox
        .network()
        .tunnel(
            tunnel_target(&status.listen_address)?,
            TunnelOptions::default(),
        )
        .await?)
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
