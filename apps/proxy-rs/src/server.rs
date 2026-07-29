// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! The listener and its shutdown behaviour.
//!
//! Shutdown is deliberately patient: preview traffic includes terminals, log
//! tails, and tunnels that are supposed to stay open for hours. New connections
//! stop immediately, existing ones are allowed to finish, and only the
//! configured timeout ends them.

use std::io;
use std::net::SocketAddr;
use std::sync::Arc;

use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;
use tokio_rustls::TlsAcceptor;

use crate::config::{Config, TlsConfig};
use crate::proxy::Proxy;

pub async fn serve(
    proxy: Arc<Proxy>,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> io::Result<()> {
    let config = proxy.config();
    let address = SocketAddr::from(([0, 0, 0, 0], config.proxy_port));
    let listener = TcpListener::bind(address).await?;
    let tls = match &config.tls {
        Some(tls) => Some(tls_acceptor(tls)?),
        None => None,
    };

    tracing::info!(
        port = config.proxy_port,
        tls = tls.is_some(),
        "proxy server is running"
    );

    // Every connection task holds a sender; the receiver resolves once they have
    // all been dropped, which is how "all in-flight work is finished" is known.
    let (in_flight, mut all_finished) = mpsc::channel::<()>(1);
    let shutdown_timeout = config.shutdown_timeout;
    let mut shutdown = Box::pin(shutdown);

    loop {
        let accepted = tokio::select! {
            accepted = listener.accept() => accepted,
            _ = &mut shutdown => break,
        };

        let (stream, remote_addr) = match accepted {
            Ok(accepted) => accepted,
            Err(err) => {
                tracing::warn!(error = %err, "failed to accept connection");
                continue;
            }
        };

        let proxy = proxy.clone();
        let tls = tls.clone();
        let in_flight = in_flight.clone();
        tokio::spawn(async move {
            if let Err(err) = serve_connection(proxy, stream, remote_addr, tls).await {
                tracing::debug!(%remote_addr, error = %err, "connection closed with an error");
            }
            drop(in_flight);
        });
    }

    drop(in_flight);
    tracing::info!("no longer accepting connections, waiting for active requests to finish");

    match tokio::time::timeout(shutdown_timeout, all_finished.recv()).await {
        Ok(_) => {
            tracing::info!("all active requests finished");
            Ok(())
        }
        Err(_) => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "shutdown timeout reached with requests still in flight",
        )),
    }
}

async fn serve_connection(
    proxy: Arc<Proxy>,
    stream: TcpStream,
    remote_addr: SocketAddr,
    tls: Option<TlsAcceptor>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    stream.set_nodelay(true)?;

    let service = service_fn(move |request| {
        let proxy = proxy.clone();
        async move {
            // CONNECT never reaches the router: its target is an authority, not
            // a path, and it ends in a raw byte pipe rather than a response body.
            let response = if request.method() == http::Method::CONNECT {
                proxy.handle_connect(request).await
            } else {
                proxy.handle(request, remote_addr).await
            };
            Ok::<_, std::convert::Infallible>(response)
        }
    });

    // HTTP/1 only: upgrades and CONNECT tunnels are HTTP/1 mechanics, and the
    // load balancer in front of the proxy speaks HTTP/1 to its targets.
    let connection = hyper::server::conn::http1::Builder::new();

    match tls {
        Some(tls) => {
            let stream = tls.accept(stream).await?;
            connection
                .serve_connection(TokioIo::new(stream), service)
                .with_upgrades()
                .await?;
        }
        None => {
            connection
                .serve_connection(TokioIo::new(stream), service)
                .with_upgrades()
                .await?;
        }
    }

    Ok(())
}

fn tls_acceptor(config: &TlsConfig) -> io::Result<TlsAcceptor> {
    let certificates: Vec<_> = rustls_pemfile::certs(&mut io::BufReader::new(std::fs::File::open(
        &config.cert_file,
    )?))
    .collect::<Result<_, _>>()?;

    let key = rustls_pemfile::private_key(&mut io::BufReader::new(std::fs::File::open(
        &config.key_file,
    )?))?
    .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "no private key in TLS_KEY_FILE"))?;

    let server_config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certificates, key)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;

    Ok(TlsAcceptor::from(Arc::new(server_config)))
}

/// Resolves on the first `SIGINT`/`SIGTERM`. A second one exits immediately, so
/// an operator is never stuck waiting out the drain.
pub async fn shutdown_signal(config: &Config) {
    let timeout = config.shutdown_timeout;

    wait_for_signal().await;
    tracing::info!(
        drain_timeout_s = timeout.as_secs(),
        "received shutdown signal, draining (send it again to exit now)"
    );

    tokio::spawn(async {
        wait_for_signal().await;
        tracing::warn!("received a second shutdown signal, exiting now");
        std::process::exit(1);
    });
}

async fn wait_for_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut interrupt = signal(SignalKind::interrupt()).expect("failed to listen for SIGINT");
        let mut terminate = signal(SignalKind::terminate()).expect("failed to listen for SIGTERM");

        tokio::select! {
            _ = interrupt.recv() => {}
            _ = terminate.recv() => {}
        }
    }

    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
