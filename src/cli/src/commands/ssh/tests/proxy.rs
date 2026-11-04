use super::*;
use std::io::{self, Cursor};
use std::os::unix::net::UnixStream;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context as TaskContext, Poll};
use std::time::Duration;
use tokio::io::ReadBuf;

#[derive(Clone, Default)]
struct Output(Arc<Mutex<Vec<u8>>>);

impl Write for Output {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn binary_transfer_half_closes_upload_and_drains_the_reply() {
    let payload: Vec<u8> = (0..131_072).map(|n| n as u8).collect();
    let input = payload.clone();
    let output = Output::default();
    let captured = output.clone();
    // Much smaller than either payload: both directions must handle backpressure.
    let (connection, mut peer) = tokio::io::duplex(64);
    let (reader, writer) = tokio::io::split(connection);
    let (result, ()) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(
            relay(reader, writer, move || Cursor::new(input), move || output),
            async {
                let mut request = Vec::new();
                peer.read_to_end(&mut request).await.unwrap();
                assert_eq!(request, payload);
                // Reply only after seeing EOF, proving that stdin half-closes the tunnel.
                request.reverse();
                peer.write_all(&request).await.unwrap();
                peer.shutdown().await.unwrap();
            }
        )
    })
    .await
    .expect("relay must finish after the peer closes");
    result.unwrap();
    assert_eq!(
        *captured.0.lock().unwrap(),
        payload.into_iter().rev().collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn remote_eof_finishes_while_stdin_stays_open() {
    let (stdin, held_open) = UnixStream::pair().unwrap();
    stdin
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let output = Output::default();
    let captured = output.clone();
    tokio::time::timeout(
        Duration::from_secs(1),
        relay(
            Cursor::new(b"last bytes"),
            tokio::io::sink(),
            move || stdin,
            move || output,
        ),
    )
    .await
    .expect("remote EOF must not wait for stdin")
    .unwrap();
    // Reaching this assertion while the writer is still alive proves we did not wait for stdin.
    assert_eq!(*captured.0.lock().unwrap(), b"last bytes");
    drop(held_open);
}

struct FailedIo;

impl Read for FailedIo {
    fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
        Err(io::Error::other("injected read failure"))
    }
}

impl Write for FailedIo {
    fn write(&mut self, _: &[u8]) -> io::Result<usize> {
        Err(io::Error::other("injected write failure"))
    }

    fn flush(&mut self) -> io::Result<()> {
        unreachable!("failed writes must not be flushed")
    }
}

impl AsyncRead for FailedIo {
    fn poll_read(
        self: Pin<&mut Self>,
        _: &mut TaskContext<'_>,
        _: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Poll::Ready(Err(io::Error::other("injected tunnel failure")))
    }
}

impl AsyncWrite for FailedIo {
    fn poll_write(
        self: Pin<&mut Self>,
        _: &mut TaskContext<'_>,
        _: &[u8],
    ) -> Poll<io::Result<usize>> {
        Poll::Ready(Err(io::Error::other("injected tunnel failure")))
    }

    fn poll_flush(self: Pin<&mut Self>, _: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _: &mut TaskContext<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

async fn assert_error(call: impl Future<Output = Result<()>>, expected: &str) {
    let error = tokio::time::timeout(Duration::from_secs(5), call)
        .await
        .expect("I/O failure must terminate the relay")
        .unwrap_err();
    assert!(error.to_string().contains(expected), "{error:#}");
    assert!(
        format!("{error:#}").contains("injected"),
        "preserve the I/O cause: {error:#}"
    );
}

#[tokio::test]
async fn stdin_and_tunnel_write_errors_propagate_without_waiting_for_remote_eof() {
    let (reader, _held_open) = tokio::io::duplex(64);
    assert_error(
        relay(reader, tokio::io::sink(), || FailedIo, io::sink),
        "read SSH proxy stdin",
    )
    .await;
    let (reader, _held_open) = tokio::io::duplex(64);
    assert_error(
        relay(reader, FailedIo, || Cursor::new(b"request"), io::sink),
        "write SSH tunnel",
    )
    .await;
}

#[tokio::test]
async fn tunnel_read_and_stdout_write_errors_propagate() {
    assert_error(
        relay(FailedIo, tokio::io::sink(), io::empty, io::sink),
        "read SSH tunnel",
    )
    .await;
    assert_error(
        relay(Cursor::new(b"reply"), tokio::io::sink(), io::empty, || {
            FailedIo
        }),
        "write SSH proxy stdout",
    )
    .await;
}
