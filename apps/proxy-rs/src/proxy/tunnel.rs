// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! Raw TCP tunnels from the proxy, through a runner, into a box.
//!
//! A box port is not routable from here: the runner in front of it is. The
//! runner exposes `CONNECT /v1/boxes/{id}/network/tunnel?port=N`, which turns an
//! HTTP connection into a byte pipe to that port. Everything the proxy sends to
//! a guest port — plain HTTP, WebSockets, or a client's own CONNECT tunnel —
//! rides on one of these.

use std::io;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::task::{Context, Poll};
use std::time::Duration;

use bytes::{Buf, Bytes};
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;

use crate::api::RunnerInfo;

const SETUP_TIMEOUT: Duration = Duration::from_secs(10);

/// A CONNECT response has no legitimate reason to be large; the cap stops a
/// misbehaving runner from making us buffer without bound.
const MAX_RESPONSE_HEADER_BYTES: usize = 8 * 1024;

/// A byte pipe to a port inside a box.
pub struct TunnelStream {
    transport: Transport,
    /// Bytes read while parsing the CONNECT response that belong to the tunnel.
    prefix: Bytes,
}

enum Transport {
    Plain(TcpStream),
    Tls(Box<TlsStream<TcpStream>>),
}

/// Opens a tunnel to `port` inside `box_id` via its runner.
pub async fn dial(runner: &RunnerInfo, box_id: &str, port: u16) -> io::Result<TunnelStream> {
    tokio::time::timeout(SETUP_TIMEOUT, connect(runner, box_id, port))
        .await
        .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "runner tunnel setup timed out"))?
}

async fn connect(runner: &RunnerInfo, box_id: &str, port: u16) -> io::Result<TunnelStream> {
    let endpoint = RunnerEndpoint::parse(&runner.api_url)?;
    let stream = TcpStream::connect((endpoint.host.as_str(), endpoint.port)).await?;
    stream.set_nodelay(true)?;

    let mut transport = if endpoint.tls {
        let server_name = rustls::pki_types::ServerName::try_from(endpoint.host.clone())
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err))?;
        Transport::Tls(Box::new(
            TlsConnector::from(tls_config())
                .connect(server_name, stream)
                .await?,
        ))
    } else {
        Transport::Plain(stream)
    };

    let request = format!(
        "CONNECT /v1/boxes/{}/network/tunnel?port={port} HTTP/1.1\r\n\
         Host: {}\r\n\
         X-BoxLite-Authorization: Bearer {}\r\n\
         \r\n",
        utf8_percent_encode(box_id, NON_ALPHANUMERIC),
        endpoint.authority(),
        runner.api_key,
    );
    transport.write_all(request.as_bytes()).await?;
    transport.flush().await?;

    let prefix = read_connect_response(&mut transport).await?;
    Ok(TunnelStream { transport, prefix })
}

/// Consumes the CONNECT response, returning whatever tunnel bytes arrived in the
/// same read.
async fn read_connect_response(transport: &mut Transport) -> io::Result<Bytes> {
    let mut buffer = Vec::with_capacity(256);
    let mut chunk = [0_u8; 256];

    let body_start = loop {
        let read = transport.read(&mut chunk).await?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "runner closed the connection during CONNECT",
            ));
        }
        buffer.extend_from_slice(&chunk[..read]);

        if let Some(end) = find_header_end(&buffer) {
            break end;
        }
        if buffer.len() > MAX_RESPONSE_HEADER_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "runner CONNECT response headers too large",
            ));
        }
    };

    let status_line = buffer
        .split(|byte| *byte == b'\r')
        .next()
        .map(String::from_utf8_lossy)
        .unwrap_or_default()
        .to_string();
    if !status_line.starts_with("HTTP/1.1 200") && !status_line.starts_with("HTTP/1.0 200") {
        return Err(io::Error::other(format!(
            "runner CONNECT returned {status_line}"
        )));
    }

    Ok(Bytes::from(buffer[body_start..].to_vec()))
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|start| start + 4)
}

/// Where a runner's API lives, with the scheme's default port filled in.
struct RunnerEndpoint {
    host: String,
    port: u16,
    tls: bool,
}

impl RunnerEndpoint {
    fn parse(api_url: &str) -> io::Result<Self> {
        let (scheme, rest) = api_url.split_once("://").ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "runner URL has no scheme")
        })?;
        let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
        if authority.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "runner URL has no host",
            ));
        }

        let tls = scheme.eq_ignore_ascii_case("https");
        let (host, port) = match super::host::split_host_port(authority) {
            Some((host, port)) => (
                host.to_string(),
                port.parse().map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "runner URL has an invalid port",
                    )
                })?,
            ),
            None => (authority.to_string(), if tls { 443 } else { 80 }),
        };

        Ok(Self { host, port, tls })
    }

    fn authority(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

fn tls_config() -> Arc<rustls::ClientConfig> {
    static CONFIG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();

    CONFIG
        .get_or_init(|| {
            let mut roots = rustls::RootCertStore::empty();
            let loaded = rustls_native_certs::load_native_certs();
            for error in &loaded.errors {
                tracing::warn!(error = %error, "failed to load a native root certificate");
            }
            for certificate in loaded.certs {
                if let Err(err) = roots.add(certificate) {
                    tracing::warn!(error = %err, "skipped an unusable root certificate");
                }
            }

            Arc::new(
                rustls::ClientConfig::builder()
                    .with_root_certificates(roots)
                    .with_no_client_auth(),
            )
        })
        .clone()
}

impl TunnelStream {
    /// Pre-read tunnel bytes that must be replayed before reading the socket.
    #[cfg(test)]
    pub fn buffered(&self) -> &Bytes {
        &self.prefix
    }
}

impl super::Proxy {
    /// Answers `CONNECT <port>-<boxId>.<domain>` by handing the client a raw
    /// pipe to that port. This is how non-HTTP protocols reach a box; only
    /// public boxes are reachable this way, because a raw tunnel carries no
    /// credential the proxy could check per message.
    pub async fn handle_connect(
        &self,
        mut request: http::Request<hyper::body::Incoming>,
    ) -> http::Response<crate::body::Body> {
        let Ok((box_id, port)) = tunnel_target(&super::request_host(&request)) else {
            return refuse(http::StatusCode::BAD_REQUEST, "invalid tunnel host");
        };

        match self.box_is_public(&box_id).await {
            Ok(true) => {}
            Ok(false) => return refuse(http::StatusCode::FORBIDDEN, "box is not public"),
            Err(err) => {
                tracing::warn!(box_id, error = %err, "tunnel rejected: visibility unavailable");
                return refuse(http::StatusCode::BAD_GATEWAY, "box visibility unavailable");
            }
        }

        let runner = match self.runners.for_box(&box_id).await {
            Ok(runner) => runner,
            Err(err) => {
                tracing::warn!(box_id, error = %err, "tunnel rejected: runner unavailable");
                return refuse(http::StatusCode::BAD_GATEWAY, "runner unavailable");
            }
        };

        // Dialled before the 200 so a failure is still a real HTTP error the
        // client can read, not a dead tunnel.
        let tunnel = match dial(&runner, &box_id, port).await {
            Ok(tunnel) => tunnel,
            Err(err) => {
                tracing::warn!(box_id, port, error = %err, "tunnel rejected: dial failed");
                return refuse(http::StatusCode::BAD_GATEWAY, "runner tunnel unavailable");
            }
        };

        let upgraded = hyper::upgrade::on(&mut request);
        tokio::spawn(async move {
            let client = match upgraded.await {
                Ok(client) => client,
                Err(err) => {
                    tracing::warn!(box_id, error = %err, "tunnel upgrade failed");
                    return;
                }
            };

            let mut client = hyper_util::rt::TokioIo::new(client);
            let mut tunnel = tunnel;
            if let Err(err) = tokio::io::copy_bidirectional(&mut client, &mut tunnel).await {
                tracing::warn!(box_id, port, error = %err, "tunnel stream closed with error");
            }
        });

        http::Response::new(crate::body::empty())
    }
}

/// Extracts the box and port a CONNECT is aimed at. The authority is the same
/// preview hostname an HTTP request would use.
fn tunnel_target(authority: &str) -> Result<(String, u16), crate::error::ProxyError> {
    let preview = super::host::parse_host(authority)?;
    if preview.box_id_or_token.is_empty() {
        return Err(crate::error::ProxyError::bad_request("invalid tunnel host"));
    }

    let box_id = match super::host::decode_direct_box_id(&preview.box_id_or_token)? {
        Some(decoded) => decoded,
        None => preview.box_id_or_token,
    };

    let port: u16 = preview
        .target_port
        .parse()
        .map_err(|_| crate::error::ProxyError::bad_request("invalid tunnel port"))?;
    if port == 0 {
        return Err(crate::error::ProxyError::bad_request("invalid tunnel port"));
    }

    Ok((box_id, port))
}

/// CONNECT clients are tools, not browsers: a plain-text reason is more useful
/// to them than a JSON envelope.
fn refuse(status: http::StatusCode, reason: &str) -> http::Response<crate::body::Body> {
    http::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(crate::body::full(format!("{reason}\n")))
        .expect("a status and one header always build a valid response")
}

impl AsyncRead for TunnelStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if !self.prefix.is_empty() {
            let take = self.prefix.len().min(buf.remaining());
            let replayed = self.prefix.slice(..take);
            buf.put_slice(&replayed);
            self.prefix.advance(take);
            return Poll::Ready(Ok(()));
        }
        Pin::new(&mut self.transport).poll_read(cx, buf)
    }
}

impl AsyncWrite for TunnelStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.transport).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.transport).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.transport).poll_shutdown(cx)
    }
}

impl AsyncRead for Transport {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_read(cx, buf),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for Transport {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_write(cx, buf),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_write(cx, buf),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_flush(cx),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_flush(cx),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Self::Plain(stream) => Pin::new(stream).poll_shutdown(cx),
            Self::Tls(stream) => Pin::new(stream.as_mut()).poll_shutdown(cx),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncBufReadExt;
    use tokio::net::TcpListener;

    #[test]
    fn fills_in_the_default_port_for_the_scheme() {
        let https = RunnerEndpoint::parse("https://runner.test/api").expect("parses");
        assert_eq!(
            (https.host.as_str(), https.port, https.tls),
            ("runner.test", 443, true)
        );

        let http = RunnerEndpoint::parse("http://runner.test").expect("parses");
        assert_eq!(
            (http.host.as_str(), http.port, http.tls),
            ("runner.test", 80, false)
        );

        let explicit = RunnerEndpoint::parse("http://127.0.0.1:8080/").expect("parses");
        assert_eq!((explicit.host.as_str(), explicit.port), ("127.0.0.1", 8080));

        assert!(RunnerEndpoint::parse("runner.test").is_err());
    }

    #[tokio::test]
    async fn sends_an_authenticated_connect_and_keeps_early_bytes() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("binds");
        let address = listener.local_addr().expect("has an address");

        let runner = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accepts");
            let mut reader = tokio::io::BufReader::new(stream);

            let mut request_line = String::new();
            reader.read_line(&mut request_line).await.expect("reads");

            let mut headers = Vec::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).await.expect("reads");
                if line == "\r\n" {
                    break;
                }
                headers.push(line);
            }

            // The 200 and the first tunnel bytes arrive in one write, which is
            // exactly the case that loses data if the reader over-buffers.
            reader
                .get_mut()
                .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\nearly-bytes")
                .await
                .expect("writes");
            (request_line, headers)
        });

        let mut tunnel = dial(
            &RunnerInfo {
                api_url: format!("http://{address}"),
                api_key: "runner-key".into(),
            },
            "AbCdEf123456",
            3000,
        )
        .await
        .expect("tunnel opens");

        let (request_line, headers) = runner.await.expect("runner task");
        assert_eq!(
            request_line,
            "CONNECT /v1/boxes/AbCdEf123456/network/tunnel?port=3000 HTTP/1.1\r\n"
        );
        assert!(
            headers
                .iter()
                .any(|header| header == "X-BoxLite-Authorization: Bearer runner-key\r\n"),
            "runner key must be presented: {headers:?}"
        );

        assert_eq!(tunnel.buffered().as_ref(), b"early-bytes");
        let mut replayed = [0_u8; 11];
        tunnel.read_exact(&mut replayed).await.expect("replays");
        assert_eq!(&replayed, b"early-bytes");
    }

    #[test]
    fn tunnel_target_reads_the_preview_authority() {
        let (box_id, port) =
            tunnel_target("3000-d-416243644566313233343536.proxy.test:443").expect("parses");
        assert_eq!((box_id.as_str(), port), ("AbCdEf123456", 3000));

        assert!(tunnel_target("proxy.test:443").is_err());
        assert!(
            tunnel_target("0-box.proxy.test").is_err(),
            "port 0 is not dialable"
        );
        assert!(
            tunnel_target("70000-box.proxy.test").is_err(),
            "out of range"
        );
    }

    #[tokio::test]
    async fn rejects_a_refused_tunnel() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("binds");
        let address = listener.local_addr().expect("has an address");

        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.expect("accepts");
            let mut discard = [0_u8; 512];
            let _ = stream.read(&mut discard).await;
            let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\n\r\n").await;
        });

        let result = dial(
            &RunnerInfo {
                api_url: format!("http://{address}"),
                api_key: "runner-key".into(),
            },
            "AbCdEf123456",
            3000,
        )
        .await;

        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("a refused tunnel must not produce a stream"),
        };
        assert!(error.to_string().contains("403"), "got {error}");
    }
}
