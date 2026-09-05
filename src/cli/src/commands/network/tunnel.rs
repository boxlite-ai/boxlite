//! Open a network tunnel to a box service.
//!
//! Without --listen: prints the public URL and stays running, renewing the
//! server-side liveness lease every few seconds.  Browser traffic reaches the
//! box only while this command keeps running; Ctrl-C makes the box private
//! again within the lease TTL.
//!
//! With --listen: forwards connections from a local socket to the box port AND
//! holds the liveness lease so browser access works in parallel.

use std::io::Write;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::time::Duration;

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
    #[arg(long, value_name = "ADDRESS", value_parser = parse_socket_address)]
    pub listen: Option<SocketAddress>,
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

// Comfortably under the server's lease TTL so a slow renewal round-trip
// never lets the lease lapse.
const RENEW_INTERVAL: Duration = Duration::from_secs(5);

pub async fn execute(args: TunnelArgs, global: &GlobalFlags) -> Result<()> {
    let runtime = global.create_runtime()?;
    let box_handle = runtime
        .get(&args.target)
        .await?
        .ok_or_else(|| anyhow!("No such box: {}", args.target))?;

    let guest_ip: std::net::IpAddr = boxlite::net::constants::GUEST_IP
        .parse()
        .context("BoxLite guest IP constant is invalid")?;
    let target = SocketAddr::new(guest_ip, args.port);

    let tunnel = box_handle.network().tunnel(target).await?;

    match args.listen {
        None => {
            // URL-only mode: print the URL and hold the liveness lease until
            // the user presses Ctrl-C.  Each renewal re-calls tunnel() for its
            // Redis-setex side effect and immediately drops the result.
            let url = tunnel.uri().ok_or_else(|| {
                anyhow!("local boxes have no public URL; point boxlite at a remote service with --url or --profile")
            })?;
            println!("{url}");
            println!(
                "Tunnel open — reachable while this command keeps running. Press Ctrl-C to close."
            );

            loop {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => break,
                    _ = tokio::time::sleep(RENEW_INTERVAL) => {
                        if let Err(error) = box_handle.network().tunnel(target).await {
                            eprintln!("warning: failed to renew tunnel, it may go unreachable soon: {error}");
                        }
                    }
                }
            }
        }
        Some(listen) => {
            // Local-forward mode: forward connections from a local socket AND
            // renew the liveness lease so browser access works in parallel.
            let forwarder = tunnel
                .forward_with_bound(listen, |address| {
                    println!("{address}");
                    std::io::stdout().flush().map_err(|error| {
                        boxlite::BoxliteError::Internal(format!(
                            "flush tunnel listener address: {error}"
                        ))
                    })
                })
                .await?;

            loop {
                tokio::select! {
                    result = forwarder.wait() => {
                        result?;
                        break;
                    }
                    signal = tokio::signal::ctrl_c() => {
                        signal.context("wait for Ctrl-C")?;
                        forwarder.close().await?;
                        break;
                    }
                    _ = tokio::time::sleep(RENEW_INTERVAL) => {
                        if let Err(error) = box_handle.network().tunnel(target).await {
                            eprintln!("warning: failed to renew tunnel, it may go unreachable soon: {error}");
                        }
                    }
                }
            }
        }
    }

    Ok(())
}
