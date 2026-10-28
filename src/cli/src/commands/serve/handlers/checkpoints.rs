//! Checkpoint transfers use temporary files, never checkpoint-sized buffers.
use super::super::types::ImportQuery;
use super::super::{AppState, error_from_boxlite, get_or_fetch_box};
use axum::Json;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures::StreamExt;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(in crate::commands::serve) struct PauseRequest {
    #[serde(default)]
    host_writers_stopped: bool,
}

pub(in crate::commands::serve) async fn pause(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Json(request): Json<PauseRequest>,
) -> Response {
    let box_ = match get_or_fetch_box(&state, &id).await {
        Ok(box_) => box_,
        Err(error) => return error,
    };
    match box_
        .pause(boxlite::PauseOptions {
            host_writers_stopped: request.host_writers_stopped,
        })
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => error_from_boxlite(&error),
    }
}

pub(in crate::commands::serve) async fn resume(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let box_ = match get_or_fetch_box(&state, &id).await {
        Ok(box_) => box_,
        Err(error) => return error,
    };
    match box_.resume().await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => error_from_boxlite(&error),
    }
}

fn storage(error: impl std::fmt::Display) -> boxlite::BoxliteError {
    boxlite::BoxliteError::Storage(format!("checkpoint transfer: {error}"))
}

/// Created only after native export joins its writers. A failed/uncertain
/// native export retains ownership of its own staging under the temp root.
struct CapturedPair(std::path::PathBuf);
impl Drop for CapturedPair {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_dir_all(&self.0) {
            tracing::warn!(%error, "Failed to remove completed checkpoint transfer pair");
        }
    }
}

pub(in crate::commands::serve) async fn export(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Response {
    let box_ = match get_or_fetch_box(&state, &id).await {
        Ok(box_) => box_,
        Err(error) => return error,
    };
    let result = async {
        let path = std::env::temp_dir().join(format!(
            ".boxlite-checkpoint-transfer-{}",
            ulid::Ulid::new()
        ));
        // The transfer owner outlives an HTTP disconnect, including the native
        // capture's writer-join cleanup. Never remove its parent from a handler.
        let file = tokio::spawn(async move {
            box_.export_checkpoint(&path).await?;
            let directory = CapturedPair(path.clone());
            tokio::task::spawn_blocking(move || {
                let _directory = directory;
                boxlite::checkpoint_transport::pack(&path)
            })
            .await
            .map_err(storage)?
        })
        .await
        .map_err(storage)??;
        Ok::<_, boxlite::BoxliteError>(file)
    }
    .await;
    let file = match result {
        Ok(file) => file,
        Err(error) => return error_from_boxlite(&error),
    };
    let length = match file.metadata() {
        Ok(metadata) => metadata.len(),
        Err(error) => return error_from_boxlite(&storage(error)),
    };
    let mut file = tokio::fs::File::from_std(file);
    let stream: std::pin::Pin<
        Box<dyn futures::Stream<Item = std::io::Result<axum::body::Bytes>> + Send>,
    > = Box::pin(async_stream::try_stream! {
        let mut buffer = vec![0; 64 * 1024];
        loop {
            let count = file.read(&mut buffer).await?;
            if count == 0 { break; }
            yield axum::body::Bytes::copy_from_slice(&buffer[..count]);
        }
    });
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "application/zstd")
        .header("Content-Length", length)
        .body(Body::from_stream(stream))
        .unwrap()
}

pub(in crate::commands::serve) async fn import(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ImportQuery>,
    body: Body,
) -> Response {
    let result = async {
        let mut file = tokio::fs::File::from_std(tempfile::tempfile().map_err(storage)?);
        let mut stream = body.into_data_stream();
        while let Some(chunk) = stream.next().await {
            file.write_all(&chunk.map_err(storage)?)
                .await
                .map_err(storage)?;
        }
        file.flush().await.map_err(storage)?;
        let file = file.into_std().await;
        let directory = tokio::task::spawn_blocking(move || {
            let directory = tempfile::tempdir().map_err(storage)?;
            boxlite::checkpoint_transport::unpack(file, &directory.path().join("pair"))?;
            Ok::<_, boxlite::BoxliteError>(directory)
        })
        .await
        .map_err(storage)??;
        // Once a restore is submitted, retain its input until it settles, even
        // if the caller loses the response. Import is deliberately not retried.
        let worker_state = state.clone();
        tokio::spawn(async move {
            let box_ = worker_state
                .runtime
                .import_checkpoint(
                    directory.path().join("pair"),
                    boxlite::CheckpointImportOptions { name: query.name },
                )
                .await?;
            let info = box_.info().await?;
            let response = worker_state.box_response(&info).await;
            worker_state
                .boxes
                .write()
                .await
                .insert(info.id.to_string(), Arc::new(box_));
            Ok::<_, boxlite::BoxliteError>(response)
        })
        .await
        .map_err(storage)?
    }
    .await;
    match result {
        Ok(response) => (StatusCode::CREATED, Json(response)).into_response(),
        Err(error) => error_from_boxlite(&error),
    }
}
