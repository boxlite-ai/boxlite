//! Print a remote URL or run a local tunnel listener.

use std::io::Write;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;

use anyhow::{Context, Result, anyhow};
use boxlite::{BoxTunnel, SocketAddress, TunnelOptions};
use clap::Args;

use crate::cli::GlobalFlags;

#[derive(Args, Debug)]
pub struct TunnelArgs {
    /// Box ID or name
    #[arg(value_name = "BOX")]
    pub target: String,

    /// Guest port the service listens on
    #[arg(value_name = "PORT", value_parser = clap::value_parser!(u16).range(1..))]
    pub port: u16,

    /// Bind a local TCP port/address or unix:/absolute/path socket
    #[arg(long, value_name = "ADDRESS", value_parser = parse_socket_address)]
    pub listen: Option<SocketAddress>,

    /// Require platform credentials or the tunnel's access token
    #[arg(long, conflicts_with = "revoke")]
    pub private: bool,

    /// Withdraw the port's tunnel; open connections are not closed
    #[arg(long, conflicts_with = "listen")]
    pub revoke: bool,
}

pub(crate) fn parse_socket_address(value: &str) -> std::result::Result<SocketAddress, String> {
    if let Some(path) = value.strip_prefix("unix:") {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err("Unix listener path must be absolute".to_string());
        }
        return Ok(SocketAddress::Unix(path));
    }

    if let Ok(port) = value.parse::<u16>() {
        return Ok(SocketAddress::Tcp(SocketAddr::new(
            Ipv4Addr::LOCALHOST.into(),
            port,
        )));
    }

    value
        .parse::<SocketAddr>()
        .map(SocketAddress::Tcp)
        .map_err(|_| {
            "listener must be a port, numeric IPv4:port, [IPv6]:port, or unix:/absolute/path"
                .to_string()
        })
}

pub async fn execute(args: TunnelArgs, global: &GlobalFlags) -> Result<()> {
    let runtime = global.create_runtime()?;
    let box_handle = runtime
        .get(&args.target)
        .await?
        .ok_or_else(|| anyhow!("No such box: {}", args.target))?;

    let network = box_handle.network();
    if args.revoke {
        network.revoke_tunnel(args.port).await?;
        println!("Revoked tunnel access to {}:{}", args.target, args.port);
        return Ok(());
    }
    let tunnel = network
        .tunnel(
            SocketAddr::new(Ipv4Addr::LOCALHOST.into(), args.port),
            TunnelOptions {
                is_public: !args.private,
            },
        )
        .await?;
    if args.private {
        println!(
            "{}",
            serde_json::json!({
                "uri": tunnel.uri(), "isPublic": tunnel.is_public(), "token": tunnel.token(),
            })
        );
        std::io::stdout()
            .flush()
            .context("flush tunnel descriptor")?;
    }
    let Some(listen) = args.listen else {
        let url = tunnel.uri().ok_or_else(|| {
            anyhow!("local boxes have no public URL; point boxlite at a remote service with --url or --profile")
        })?;
        if !args.private {
            println!("{url}");
        }
        return Ok(());
    };

    forward_until_interrupted(tunnel, listen, |_| {}).await
}

/// Print the bound address to stdout, run `announce`, then forward until the
/// listener fails or Ctrl-C closes it and its relays.
pub(crate) async fn forward_until_interrupted(
    tunnel: BoxTunnel,
    listen: SocketAddress,
    announce: impl FnOnce(&SocketAddress),
) -> Result<()> {
    let forwarder = tunnel
        .forward_with_bound(listen, |address| {
            println!("{address}");
            std::io::stdout().flush().map_err(|error| {
                boxlite::BoxliteError::Internal(format!("flush tunnel listener address: {error}"))
            })?;
            announce(address);
            Ok(())
        })
        .await?;

    tokio::select! {
        result = forwarder.wait() => result?,
        signal = tokio::signal::ctrl_c() => {
            signal.context("wait for Ctrl-C")?;
            forwarder.close().await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::cli::{Commands, try_parse_from};
    use crate::commands::network::NetworkCommand;

    fn tunnel_args(args: &[&str]) -> Result<super::TunnelArgs, clap::Error> {
        let cli = try_parse_from(["boxlite", "network", "tunnel"].iter().chain(args))?;
        let Commands::Network(network) = cli.command else {
            panic!("expected the network command");
        };
        let NetworkCommand::Tunnel(tunnel) = network.command else {
            panic!("expected the tunnel command");
        };
        Ok(tunnel)
    }

    #[test]
    fn revoke_flag_selects_revocation_of_the_named_port() {
        let args = tunnel_args(&["mybox", "3000", "--revoke"]).unwrap();
        assert!(args.revoke);
        assert_eq!((args.target.as_str(), args.port), ("mybox", 3000));

        assert!(!tunnel_args(&["mybox", "3000"]).unwrap().revoke);
    }

    #[test]
    fn revoke_cannot_be_combined_with_a_local_listener() {
        let err = tunnel_args(&["mybox", "3000", "--revoke", "--listen", "8080"]).unwrap_err();
        assert_eq!(err.kind(), clap::error::ErrorKind::ArgumentConflict);
    }

    #[test]
    fn private_tunnel_can_listen_but_revoke_is_mode_independent() {
        let args = tunnel_args(&["mybox", "3000", "--private", "--listen", "8080"]).unwrap();
        assert!(args.private && args.listen.is_some());
        assert!(!tunnel_args(&["mybox", "3000"]).unwrap().private);
        assert!(tunnel_args(&["mybox", "3000", "--private", "--revoke"]).is_err());
        assert!(tunnel_args(&["mybox", "3000", "--token", "secret"]).is_err());
    }
}
