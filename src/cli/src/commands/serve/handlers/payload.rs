//! Streaming request/response body helpers for archive-sized payloads.

use std::error::Error;
use std::io;
use std::path::Path;

use axum::body::Body;
use futures::StreamExt;
use tokio::io::{AsyncWriteExt, BufWriter};
use tokio_util::io::{ReaderStream, StreamReader};

const RESPONSE_CHUNK_SIZE: usize = 64 * 1024;
pub(in crate::commands::serve) const MAX_REQUEST_BODY_BYTES: usize =
    boxlite_shared::constants::files::MAX_UPLOAD_BYTES as usize;

#[derive(Debug)]
pub(super) enum BodyWriteError {
    BodyTooLarge,
    Io(io::Error),
}

impl From<io::Error> for BodyWriteError {
    fn from(err: io::Error) -> Self {
        if is_length_limit_error(&err) {
            Self::BodyTooLarge
        } else {
            Self::Io(err)
        }
    }
}

pub(super) async fn write_body_to_file(body: Body, path: &Path) -> Result<(), BodyWriteError> {
    let reader = StreamReader::new(
        body.into_data_stream()
            .map(|chunk| chunk.map_err(io::Error::other)),
    );
    let mut reader = std::pin::pin!(reader);
    let mut file = BufWriter::new(tokio::fs::File::create(path).await?);

    tokio::io::copy(&mut reader, &mut file).await?;
    file.flush().await?;
    Ok(())
}

fn is_length_limit_error(err: &io::Error) -> bool {
    let mut source = err.source();
    while let Some(err) = source {
        if err.is::<http_body_util::LengthLimitError>() {
            return true;
        }
        source = err.source();
    }
    false
}

pub(super) async fn stream_file_body(
    path: &Path,
    temp_dirs: Vec<tempfile::TempDir>,
) -> io::Result<Body> {
    let file = tokio::fs::File::open(path).await?;
    let reader = ReaderStream::with_capacity(file, RESPONSE_CHUNK_SIZE);
    let guarded = reader.map(move |chunk| {
        let _ = &temp_dirs;
        chunk
    });

    Ok(Body::from_stream(guarded))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Bytes;

    #[tokio::test]
    async fn write_body_to_file_reports_length_limit_as_body_too_large() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("request.bin");
        let body = Body::new(http_body_util::Limited::new(
            http_body_util::Full::new(Bytes::from_static(b"too large")),
            3,
        ));

        let err = write_body_to_file(body, &path).await.unwrap_err();

        assert!(matches!(err, BodyWriteError::BodyTooLarge));
    }

    #[tokio::test]
    async fn write_body_to_file_persists_streamed_body() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("request.bin");

        write_body_to_file(Body::from(Bytes::from_static(b"hello stream")), &path)
            .await
            .unwrap();

        let written = tokio::fs::read(&path).await.unwrap();
        assert_eq!(written, b"hello stream");
    }

    #[tokio::test]
    async fn stream_file_body_reads_file_without_prebuffering() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("response.bin");
        tokio::fs::write(&path, b"chunked response").await.unwrap();

        let body = stream_file_body(&path, vec![dir]).await.unwrap();
        let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();

        assert_eq!(&bytes[..], b"chunked response");
    }

    #[tokio::test]
    async fn stream_file_body_errors_before_response_for_missing_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missing.bin");

        let err = stream_file_body(&path, vec![dir]).await.unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }
}
