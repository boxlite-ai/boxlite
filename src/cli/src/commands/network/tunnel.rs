//! Open a network tunnel to a box service.
//!
//! Without --listen: prints the public URL and holds a WebSocket connection to
//! the API's tunnel-live endpoint.  Browser traffic reaches the box only while
//! this command is running; when the connection closes the API deletes the
//! Redis key immediately, making the box private again.
//!
//! With --listen: forwards connections from a local socket to the box port AND
//! holds the same WebSocket keepalive so browser access works in parallel.

use std::io::Write;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;

use anyhow::{Context, Result, anyhow};
use boxlite::SocketAddress;
use clap::Args;
use futures::{SinkExt, StreamExt};

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

/// Hold a WebSocket to the API's tunnel-live endpoint for `box_id`.
/// The connection closing (for any reason) causes the API to delete the Redis
/// liveness key, making the box private again immediately.
async fn hold_tunnel_live(api_url: &str, bearer: &str, box_id: &str) -> Result<()> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::HeaderValue;

    // Convert http(s):// → ws(s)://
    let ws_url = api_url
        .replacen("https://", "wss://", 1)
        .replacen("http://", "ws://", 1);
    let url = format!("{ws_url}/api/v1/boxes/{box_id}/network/tunnel/live");

    let mut req = url.into_client_request().context("build WS request")?;
    req.headers_mut().insert(
        "Authorization",
        HeaderValue::from_str(&format!("Bearer {bearer}")).context("build auth header")?,
    );

    let (mut ws, _) = tokio_tungstenite::connect_async(req).await.context("connect tunnel-live WS")?;

    // Drive the WS: tungstenite auto-replies to Ping frames; we just need to
    // drain the stream until the server closes or we get cancelled.
    loop {
        match ws.next().await {
            Some(Ok(msg)) if msg.is_close() => break,
            Some(Ok(_)) => {}
            Some(Err(e)) => return Err(anyhow!("tunnel-live WS error: {e}")),
            None => break,
        }
    }

    let _ = ws.close(None).await;
    Ok(())
}

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

    let url = tunnel.uri().ok_or_else(|| {
        anyhow!("local boxes have no public URL; point boxlite at a remote service with --url or --profile")
    })?;

    // Resolve REST options for the WS keepalive connection.
    let rest = global.rest_options()?;
    let bearer = rest
        .credential
        .as_ref()
        .ok_or_else(|| anyhow!("no API key configured; use `boxlite auth login` or set BOXLITE_API_KEY"))?
        .get_token()
        .await
        .context("resolve API key")?
        .token;
    // Use the target name/id as given — the API resolves names to IDs.
    let box_id = &args.target;

    match args.listen {
        None => {
            println!("{url}");
            println!("Tunnel open — reachable while this command keeps running. Press Ctrl-C to close.");

            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                result = hold_tunnel_live(&rest.url, &bearer, &box_id) => {
                    if let Err(e) = result {
                        eprintln!("warning: tunnel keepalive lost: {e}");
                    }
                }
            }
        }
        Some(listen) => {
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

            tokio::select! {
                result = forwarder.wait() => { result?; }
                signal = tokio::signal::ctrl_c() => {
                    signal.context("wait for Ctrl-C")?;
                    forwarder.close().await?;
                }
                result = hold_tunnel_live(&rest.url, &bearer, &box_id) => {
                    if let Err(e) = result {
                        eprintln!("warning: tunnel keepalive lost: {e}");
                    }
                    forwarder.close().await?;
                }
            }
        }
    }

    Ok(())
}
