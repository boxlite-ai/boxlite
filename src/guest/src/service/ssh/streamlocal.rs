//! Container-scoped relay for OpenSSH direct streamlocal forwarding.

use crate::service::ssh::limits::{FORWARD_CONNECT_TIMEOUT, MAX_STREAMLOCAL_PATH_BYTES};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::path::Path;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};
use tokio::net::UnixStream;

pub(crate) const INTERNAL_STREAMLOCAL_ARG: &str = "--boxlite-internal-streamlocal";
pub(crate) const STREAMLOCAL_READY_MAGIC: &[u8] = b"\0boxlite-streamlocal-ready\0";

/// Accept only Linux pathname sockets that can fit in `sockaddr_un::sun_path`.
///
/// The path is interpreted only after ContainerExecutor has entered the target
/// container's mount namespace, so an authorized client never selects a guest
/// filesystem path.
pub(crate) fn is_valid_target(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= MAX_STREAMLOCAL_PATH_BYTES
        && !path.contains('\0')
        && Path::new(path).is_absolute()
}

pub(crate) fn run_internal(socket_path: String) -> BoxliteResult<()> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| BoxliteError::Internal(format!("streamlocal runtime: {error}")))?;
    runtime.block_on(relay_streamlocal(
        &socket_path,
        tokio::io::stdin(),
        tokio::io::stdout(),
    ))
}

pub(crate) fn parse_internal_args(args: &[String]) -> BoxliteResult<String> {
    let [socket_path] = args else {
        return Err(BoxliteError::Config(
            "internal streamlocal workload requires exactly one socket path".into(),
        ));
    };
    let socket_path = socket_path.clone();
    if !is_valid_target(&socket_path) {
        return Err(BoxliteError::Config(
            "invalid internal streamlocal socket path".into(),
        ));
    }
    Ok(socket_path)
}

async fn relay_streamlocal<R, W>(
    socket_path: &str,
    mut input: R,
    mut output: W,
) -> BoxliteResult<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let socket = tokio::time::timeout(FORWARD_CONNECT_TIMEOUT, UnixStream::connect(socket_path))
        .await
        .map_err(|_| BoxliteError::Execution("streamlocal connect timed out".into()))?
        .map_err(|error| BoxliteError::Execution(format!("streamlocal connect failed: {error}")))?;

    // This prefix is consumed by the parent bridge. It proves that pathname
    // lookup and connect succeeded inside the container mount namespace before
    // the SSH server confirms the channel open.
    output
        .write_all(STREAMLOCAL_READY_MAGIC)
        .await
        .map_err(|error| {
            BoxliteError::Execution(format!("streamlocal readiness write failed: {error}"))
        })?;
    output.flush().await.map_err(|error| {
        BoxliteError::Execution(format!("streamlocal readiness flush failed: {error}"))
    })?;
    let (mut socket_reader, mut socket_writer) = socket.into_split();

    let client_to_socket = async {
        tokio::io::copy(&mut input, &mut socket_writer).await?;
        socket_writer.shutdown().await
    };
    let socket_to_client = async {
        tokio::io::copy(&mut socket_reader, &mut output).await?;
        output.shutdown().await
    };
    // Both halves have independent lifetimes. In particular, a Unix peer may
    // shut down its write side after a greeting while continuing to consume a
    // request, so completion of either pump must not cancel the other.
    let (uplink, downlink) = tokio::join!(client_to_socket, socket_to_client);
    uplink
        .and(downlink)
        .map_err(|error| BoxliteError::Execution(format!("streamlocal relay failed: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixListener;

    #[test]
    fn target_must_be_absolute_nul_free_and_fit_linux_sun_path() {
        assert!(is_valid_target("/run/service.sock"));
        assert!(!is_valid_target("run/service.sock"));
        assert!(!is_valid_target("/run/bad\0socket"));
        assert!(!is_valid_target(&format!(
            "/{}",
            "s".repeat(MAX_STREAMLOCAL_PATH_BYTES)
        )));
        assert!(is_valid_target(&format!(
            "/{}",
            "s".repeat(MAX_STREAMLOCAL_PATH_BYTES - 1)
        )));
    }

    #[test]
    fn helper_requires_exactly_one_valid_target() {
        assert_eq!(
            parse_internal_args(&[String::from("/run/service.sock")]).unwrap(),
            "/run/service.sock"
        );
        assert!(parse_internal_args(&[]).is_err());
        assert!(parse_internal_args(&[String::from("relative.sock")]).is_err());
        assert!(parse_internal_args(&[
            String::from("/run/one.sock"),
            String::from("/run/two.sock")
        ])
        .is_err());
    }

    #[tokio::test]
    async fn relay_crosses_a_real_unix_socket_and_preserves_half_close() {
        let directory = tempfile::tempdir().unwrap();
        let socket_path = directory.path().join("service.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();

        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            stream.read_to_end(&mut request).await.unwrap();
            assert_eq!(request, b"request");
            stream.write_all(b"response").await.unwrap();
            stream.shutdown().await.unwrap();
        });

        let (mut input_writer, input_reader) = tokio::io::duplex(64);
        let (output_writer, mut output_reader) = tokio::io::duplex(64);
        let relay_path = socket_path.to_string_lossy().into_owned();
        let relay = tokio::spawn(async move {
            relay_streamlocal(&relay_path, input_reader, output_writer).await
        });

        input_writer.write_all(b"request").await.unwrap();
        input_writer.shutdown().await.unwrap();
        let mut response = Vec::new();
        output_reader.read_to_end(&mut response).await.unwrap();

        relay.await.unwrap().unwrap();
        server.await.unwrap();
        assert_eq!(response, [STREAMLOCAL_READY_MAGIC, b"response"].concat());
    }

    #[tokio::test]
    async fn socket_write_eof_does_not_cancel_later_client_input() {
        let directory = tempfile::tempdir().unwrap();
        let socket_path = directory.path().join("service.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();

        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            stream.write_all(b"greeting").await.unwrap();
            stream.shutdown().await.unwrap();
            let mut request = Vec::new();
            stream.read_to_end(&mut request).await.unwrap();
            request
        });

        let (mut input_writer, input_reader) = tokio::io::duplex(64);
        let (output_writer, mut output_reader) = tokio::io::duplex(64);
        let relay_path = socket_path.to_string_lossy().into_owned();
        let relay = tokio::spawn(async move {
            relay_streamlocal(&relay_path, input_reader, output_writer).await
        });

        let mut greeting = vec![0; STREAMLOCAL_READY_MAGIC.len() + b"greeting".len()];
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            output_reader.read_exact(&mut greeting),
        )
        .await
        .expect("relay must deliver the socket's write side")
        .unwrap();
        assert_eq!(greeting, [STREAMLOCAL_READY_MAGIC, b"greeting"].concat());

        input_writer.write_all(b"late request").await.unwrap();
        input_writer.shutdown().await.unwrap();

        let request = tokio::time::timeout(std::time::Duration::from_secs(1), server)
            .await
            .expect("socket reader must survive its write-side EOF")
            .unwrap();
        assert_eq!(request, b"late request");
        relay.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn failed_connect_emits_no_readiness_prefix() {
        let directory = tempfile::tempdir().unwrap();
        let socket_path = directory.path().join("missing.sock");
        let (_input_writer, input_reader) = tokio::io::duplex(64);
        let (output_writer, mut output_reader) = tokio::io::duplex(64);

        let result =
            relay_streamlocal(socket_path.to_str().unwrap(), input_reader, output_writer).await;
        let mut output = Vec::new();
        output_reader.read_to_end(&mut output).await.unwrap();

        assert!(result.is_err());
        assert!(output.is_empty());
    }
}
