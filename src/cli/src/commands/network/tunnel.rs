//! Print a remote URL, run a local listener, or relay a tunnel over stdio.

use std::io::Write;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;

use anyhow::{Context, Result, anyhow};
use boxlite::SocketAddress;
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
    #[arg(long, value_name = "ADDRESS", value_parser = parse_socket_address, conflicts_with = "stdio")]
    pub listen: Option<SocketAddress>,

    /// Relay raw bytes over stdin/stdout (for SSH ProxyCommand)
    #[arg(long)]
    pub stdio: bool,
}

fn parse_socket_address(value: &str) -> std::result::Result<SocketAddress, String> {
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

    let guest_ip = boxlite::net::constants::GUEST_IP
        .parse()
        .context("BoxLite guest IP constant is invalid")?;
    let network = box_handle.network();
    let target = SocketAddr::new(guest_ip, args.port);
    let tunnel = network.tunnel(target).await?;
    if args.stdio {
        let connection = tunnel.connect()?;
        // The stream owns its transport. Keeping runtime handles here would
        // lock BOXLITE_HOME for the entire SSH session and prevent controls.
        drop(network);
        drop(box_handle);
        drop(runtime);
        return super::stdio::run(connection).await;
    }
    let Some(listen) = args.listen else {
        let url = tunnel.uri().ok_or_else(|| {
            anyhow!("local boxes have no public URL; point boxlite at a remote service with --url or --profile")
        })?;
        println!("{url}");
        return Ok(());
    };

    let forwarder = tunnel
        .forward_with_bound(listen, |address| {
            println!("{address}");
            std::io::stdout().flush().map_err(|error| {
                boxlite::BoxliteError::Internal(format!("flush tunnel listener address: {error}"))
            })
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
