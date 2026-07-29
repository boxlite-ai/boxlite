// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! The two ways the proxy reaches a box, and the HTTP clients for each.
//!
//! A guest port is reached over a runner tunnel, so its client dials through
//! [`super::tunnel`] instead of DNS: the request URI's authority is
//! `<boxId>:<port>`, which the connector resolves to a runner and opens a pipe
//! to. The terminal is a normal HTTPS call to the runner's own API.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use http::Uri;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::{Connected, Connection, HttpConnector};
use hyper_util::rt::{TokioExecutor, TokioIo};

use crate::body::{Body, BoxError};

use super::runners::RunnerDirectory;
use super::tunnel::{self, TunnelStream};

const POOL_IDLE_TIMEOUT: Duration = Duration::from_secs(90);
const MAX_IDLE_PER_HOST: usize = 10;

/// Which path a request takes to the box.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Upstream {
    /// A port inside the box, over a runner tunnel.
    Guest,
    /// The runner's own API, which fronts the box terminal.
    Runner,
}

#[derive(Clone)]
pub struct Clients {
    guest: Client<GuestConnector, Body>,
    runner: Client<hyper_rustls::HttpsConnector<HttpConnector>, Body>,
}

impl Clients {
    pub fn new(runners: Arc<RunnerDirectory>) -> Self {
        let https = hyper_rustls::HttpsConnectorBuilder::new()
            .with_native_roots()
            .expect("no usable native root certificates")
            .https_or_http()
            .enable_http1()
            .build();

        Self {
            guest: Client::builder(TokioExecutor::new())
                .pool_idle_timeout(POOL_IDLE_TIMEOUT)
                .pool_max_idle_per_host(MAX_IDLE_PER_HOST)
                .build(GuestConnector { runners }),
            runner: Client::builder(TokioExecutor::new())
                .pool_idle_timeout(POOL_IDLE_TIMEOUT)
                .build(https),
        }
    }

    pub async fn send(
        &self,
        upstream: Upstream,
        request: http::Request<Body>,
    ) -> Result<http::Response<hyper::body::Incoming>, BoxError> {
        match upstream {
            Upstream::Guest => self.guest.request(request).await.map_err(BoxError::from),
            Upstream::Runner => self.runner.request(request).await.map_err(BoxError::from),
        }
    }
}

/// Resolves `<boxId>:<port>` authorities to runner tunnels — the connector is
/// where "which machine holds this box" is answered, so the rest of the client
/// stack can treat a box like any other host.
#[derive(Clone)]
struct GuestConnector {
    runners: Arc<RunnerDirectory>,
}

impl tower_service::Service<Uri> for GuestConnector {
    type Response = GuestConnection;
    type Error = BoxError;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn poll_ready(&mut self, _cx: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, uri: Uri) -> Self::Future {
        let runners = self.runners.clone();
        Box::pin(async move {
            let box_id = uri
                .host()
                .ok_or_else(|| BoxError::from("guest target has no box ID"))?
                .to_string();
            let port = uri
                .port_u16()
                .ok_or_else(|| BoxError::from("guest target has no port"))?;

            let runner = runners
                .for_box(&box_id)
                .await
                .map_err(|err| BoxError::from(format!("resolve runner for box {box_id}: {err}")))?;
            let stream = tunnel::dial(&runner, &box_id, port).await?;

            Ok(GuestConnection(TokioIo::new(stream)))
        })
    }
}

pub struct GuestConnection(TokioIo<TunnelStream>);

impl Connection for GuestConnection {
    fn connected(&self) -> Connected {
        Connected::new()
    }
}

impl hyper::rt::Read for GuestConnection {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: hyper::rt::ReadBufCursor<'_>,
    ) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_read(cx, buf)
    }
}

impl hyper::rt::Write for GuestConnection {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.get_mut().0).poll_write(cx, buf)
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.get_mut().0).poll_shutdown(cx)
    }
}
