//! Guest SSH controls and locally owned login credentials.

mod connection;
mod credentials;
mod forward;

use std::io::{Read, Write};
use std::net::SocketAddr;
use std::path::PathBuf;

use anyhow::{Context, Result, anyhow};
use boxlite::SshConfig;
use clap::{Args, Subcommand, ValueEnum};
use serde::Serialize;

use crate::cli::GlobalFlags;
use credentials::Credentials;

#[derive(Args, Debug)]
pub struct SshArgs {
    #[command(subcommand)]
    command: SshCommand,
}

#[derive(Subcommand, Debug)]
enum SshCommand {
    /// Replace the complete SSH configuration (disconnects existing sessions).
    Configure(ConfigureArgs),
    /// Query SSH listener state and host identity.
    Status(ControlArgs),
    /// Disable SSH and disconnect existing sessions.
    Disable(ControlArgs),
    /// Prepare local keys and guest SSH; print login information.
    Setup(PrepareArgs),
    /// Prepare SSH and keep a local TCP forwarder running until Ctrl-C.
    Forward(ForwardArgs),
    /// Prepare SSH and run the system SSH client through a stdio tunnel.
    Connect(ConnectArgs),
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum Format {
    Json,
    Yaml,
}

impl Format {
    fn write(self, value: &impl Serialize, mut writer: impl Write) -> Result<()> {
        match self {
            Self::Json => {
                serde_json::to_writer_pretty(&mut writer, value)?;
                writeln!(writer)?;
            }
            Self::Yaml => serde_yaml::to_writer(&mut writer, value)?,
        }
        writer.flush()?;
        Ok(())
    }
}

#[derive(Args, Debug)]
struct ControlArgs {
    /// Box ID or name
    #[arg(value_name = "BOX")]
    target: String,
    #[arg(long, value_enum, default_value = "json")]
    format: Format,
}

#[derive(Args, Debug)]
struct ConfigureArgs {
    #[command(flatten)]
    control: ControlArgs,
    /// JSON configuration file; use - to read stdin
    #[arg(long, value_name = "PATH")]
    file: PathBuf,
}

#[derive(Args, Debug)]
struct PrepareArgs {
    /// Box ID or name
    #[arg(value_name = "BOX")]
    target: String,
    /// SSH account (default for new configuration: boxlite)
    #[arg(long)]
    login: Option<String>,
    #[arg(long, value_enum, default_value = "yaml")]
    format: Format,
}

#[derive(Args, Debug)]
struct ForwardArgs {
    #[command(flatten)]
    prepare: PrepareArgs,
    /// Local TCP listener (fails if the address is already in use)
    #[arg(long, value_name = "ADDRESS", default_value = "127.0.0.1:2222")]
    listen: SocketAddr,
}

#[derive(Args, Debug)]
struct ConnectArgs {
    #[command(flatten)]
    prepare: PrepareArgs,
    /// Optional remote command, following --
    #[arg(last = true, value_name = "COMMAND")]
    command: Vec<String>,
}

// Serde's type errors can include the offending value. Never attach that error
// to the public error chain for a document containing private credentials.
fn read_config(path: &std::path::Path) -> Result<SshConfig> {
    const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
    let reader: Box<dyn Read> = if path == std::path::Path::new("-") {
        Box::new(std::io::stdin())
    } else {
        Box::new(std::fs::File::open(path).context("Open SSH configuration file")?)
    };
    let mut bytes = Vec::new();
    reader
        .take(MAX_CONFIG_BYTES + 1)
        .read_to_end(&mut bytes)
        .context("Read SSH configuration")?;
    anyhow::ensure!(
        bytes.len() as u64 <= MAX_CONFIG_BYTES,
        "SSH configuration exceeds 1 MiB"
    );
    serde_json::from_slice(&bytes)
        .map_err(|_| anyhow!("Invalid SSH configuration JSON (credential values omitted)"))
}

pub async fn execute(args: SshArgs, global: &GlobalFlags) -> Result<i32> {
    // Read and validate JSON before starting a runtime or contacting the server.
    let config = match &args.command {
        SshCommand::Configure(args) => Some(read_config(&args.file)?),
        _ => None,
    };
    let target = match &args.command {
        SshCommand::Configure(args) => &args.control.target,
        SshCommand::Status(args) | SshCommand::Disable(args) => &args.target,
        SshCommand::Setup(args) => &args.target,
        SshCommand::Forward(args) => &args.prepare.target,
        SshCommand::Connect(args) => &args.prepare.target,
    };
    let runtime = global.create_runtime()?;
    let sandbox = runtime
        .get(target)
        .await?
        .ok_or_else(|| anyhow!("No such box: {target}"))?;
    let ssh = sandbox.ssh();
    match args.command {
        SshCommand::Configure(args) => {
            let status = Credentials::configure(
                global,
                &sandbox,
                config.expect("configure input read above"),
            )
            .await?;
            args.control.format.write(&status, std::io::stdout())?;
        }
        SshCommand::Status(args) => args.format.write(&ssh.status().await?, std::io::stdout())?,
        SshCommand::Disable(args) => args
            .format
            .write(&ssh.disable().await?, std::io::stdout())?,
        SshCommand::Setup(args) => {
            let login = Credentials::prepare(global, &sandbox, args.login.as_deref()).await?;
            args.format.write(&login, std::io::stdout())?;
        }
        SshCommand::Forward(args) => {
            let login =
                Credentials::prepare(global, &sandbox, args.prepare.login.as_deref()).await?;
            let connection = sandbox
                .network()
                .tunnel(login.guest_address)
                .await?
                .connect()?;
            // Check tunnel availability before reporting success, but do not
            // retain an unauthenticated SSH connection while the listener idles.
            drop(connection);
            let id = sandbox.id().to_string();
            drop(ssh);
            drop(sandbox);
            drop(runtime);
            forward::Forwarder::run(args, global, id, login).await?;
        }
        SshCommand::Connect(args) => {
            let login =
                Credentials::prepare(global, &sandbox, args.prepare.login.as_deref()).await?;
            // ProxyCommand opens the same runtime in another process.
            drop(ssh);
            drop(sandbox);
            drop(runtime);
            args.prepare.format.write(&login, std::io::stderr())?;
            return login.connect(&args.command).await;
        }
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    #[test]
    fn ssh_all_commands_share_root_and_leaf_target_flags() {
        let flags = [
            "--home",
            "/tmp/ssh-home",
            "--config",
            "/tmp/ssh-runtime.json",
            "--url",
            "http://localhost:8100",
            "--profile",
            "tenant",
            "--path-prefix",
            "workspace",
        ];
        for operation in [
            "configure",
            "status",
            "disable",
            "setup",
            "forward",
            "connect",
        ] {
            for at_root in [false, true] {
                let mut args = vec!["boxlite"];
                if at_root {
                    args.extend(flags);
                }
                args.extend(["ssh", operation, "target"]);
                if operation == "configure" {
                    args.extend(["--file", "-"]);
                }
                if !at_root {
                    args.extend(flags);
                }
                if operation == "connect" {
                    args.extend(["--", "echo", "--home", "remote-argument"]);
                }
                let parsed = crate::cli::try_parse_from(args).unwrap();
                assert_eq!(
                    parsed.global.home.unwrap(),
                    std::path::Path::new("/tmp/ssh-home")
                );
                assert_eq!(
                    parsed.global.config.as_deref(),
                    Some("/tmp/ssh-runtime.json")
                );
                assert_eq!(parsed.global.url.as_deref(), Some("http://localhost:8100"));
                assert_eq!(parsed.global.profile.as_deref(), Some("tenant"));
                assert_eq!(parsed.global.path_prefix.as_deref(), Some("workspace"));
                if let crate::cli::Commands::Ssh(super::SshArgs {
                    command: super::SshCommand::Connect(connect),
                }) = parsed.command
                {
                    assert_eq!(connect.command, ["echo", "--home", "remote-argument"]);
                }
            }
        }
    }
}
