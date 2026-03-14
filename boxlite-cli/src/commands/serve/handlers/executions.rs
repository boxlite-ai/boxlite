//! Execution handlers: start, stream output, status, input, signal, resize.

use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use base64::Engine;
use futures::StreamExt;

use super::super::types::{ExecRequest, ExecResponse, ResizeRequest, SignalRequest};
use super::super::{
    ActiveExecution, AppState, SseItem, build_box_command, classify_boxlite_error, error_response,
    get_or_fetch_box,
};

pub(in crate::commands::serve) async fn start_execution(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    Json(req): Json<ExecRequest>,
) -> Response {
    let litebox = match get_or_fetch_box(&state, &box_id).await {
        Ok(b) => b,
        Err(resp) => return resp,
    };

    let stdin_data = req.stdin.clone();
    let cmd = build_box_command(&req);

    let mut execution = match litebox.exec(cmd).await {
        Ok(e) => e,
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            return error_response(status, e.to_string(), etype);
        }
    };

    // Take stdin handle before storing
    let mut stdin = execution.stdin();

    // Write initial stdin data if provided, then close
    let stdin = if let Some(data) = stdin_data {
        if let Some(ref mut s) = stdin {
            let _ = s.write_all(data.as_bytes()).await;
            s.close();
        }
        None
    } else {
        stdin
    };

    let exec_id = execution.id().clone();

    state
        .executions
        .write()
        .await
        .insert(exec_id.clone(), ActiveExecution::new(execution, stdin));

    (
        StatusCode::CREATED,
        Json(ExecResponse {
            execution_id: exec_id,
        }),
    )
        .into_response()
}

pub(in crate::commands::serve) async fn get_execution(
    State(state): State<Arc<AppState>>,
    Path((_box_id, exec_id)): Path<(String, String)>,
) -> Response {
    let executions = state.executions.read().await;
    if executions.contains_key(&exec_id) {
        Json(serde_json::json!({
            "execution_id": exec_id,
            "status": "running",
        }))
        .into_response()
    } else {
        error_response(
            StatusCode::NOT_FOUND,
            format!("execution not found: {exec_id}"),
            "NotFoundError",
        )
    }
}

pub(in crate::commands::serve) async fn stream_execution_output(
    State(state): State<Arc<AppState>>,
    Path((_box_id, exec_id)): Path<(String, String)>,
) -> Response {
    // Take the execution out of the map (streams can only be consumed once)
    let active = match state.executions.write().await.remove(&exec_id) {
        Some(a) => a,
        None => {
            return error_response(
                StatusCode::NOT_FOUND,
                format!("execution not found: {exec_id}"),
                "NotFoundError",
            );
        }
    };

    let started_at = active.started_at;
    let mut execution = active.execution;

    // Take stdout/stderr streams (can only be called once)
    let stdout = execution.stdout();
    let stderr = execution.stderr();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<SseItem>();

    // Spawn producer tasks for stdout and stderr
    let mut stream_count = 0u32;
    if let Some(mut out) = stdout {
        stream_count += 1;
        let tx_out = tx.clone();
        tokio::spawn(async move {
            let b64 = base64::engine::general_purpose::STANDARD;
            while let Some(line) = out.next().await {
                let encoded = b64.encode(line.as_bytes());
                let data = serde_json::json!({"data": encoded}).to_string();
                let event = Event::default().event("stdout").data(data);
                if tx_out.send(SseItem::Event(event)).is_err() {
                    break;
                }
            }
            let _ = tx_out.send(SseItem::StreamDone);
        });
    }

    if let Some(mut err_stream) = stderr {
        stream_count += 1;
        let tx_err = tx.clone();
        tokio::spawn(async move {
            let b64 = base64::engine::general_purpose::STANDARD;
            while let Some(line) = err_stream.next().await {
                let encoded = b64.encode(line.as_bytes());
                let data = serde_json::json!({"data": encoded}).to_string();
                let event = Event::default().event("stderr").data(data);
                if tx_err.send(SseItem::Event(event)).is_err() {
                    break;
                }
            }
            let _ = tx_err.send(SseItem::StreamDone);
        });
    }

    // Drop original sender so rx closes when all producers finish
    drop(tx);

    let stream = async_stream::stream! {
        // Multiplex stdout/stderr events
        let mut done = 0u32;
        while done < stream_count {
            match rx.recv().await {
                Some(SseItem::Event(event)) => {
                    yield Ok::<_, std::convert::Infallible>(event);
                }
                Some(SseItem::StreamDone) => {
                    done += 1;
                }
                None => break,
            }
        }

        // Wait for exit
        let result = execution.wait().await;
        let elapsed_ms = started_at.elapsed().as_millis() as u64;

        let (exit_code, _error_message) = match result {
            Ok(r) => (r.exit_code, r.error_message),
            Err(e) => (-1, Some(e.to_string())),
        };

        let exit_data = serde_json::json!({
            "exit_code": exit_code,
            "duration_ms": elapsed_ms,
        })
        .to_string();

        yield Ok(Event::default().event("exit").data(exit_data));
    };

    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

pub(in crate::commands::serve) async fn send_input(
    State(state): State<Arc<AppState>>,
    Path((_box_id, exec_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let close_stdin = headers
        .get("X-Close-Stdin")
        .and_then(|v| v.to_str().ok())
        .map(|v| v == "true")
        .unwrap_or(false);

    let executions = state.executions.read().await;
    let active = match executions.get(&exec_id) {
        Some(a) => a,
        None => {
            return error_response(
                StatusCode::NOT_FOUND,
                format!("execution not found: {exec_id}"),
                "NotFoundError",
            );
        }
    };

    let mut stdin_guard = active.stdin.lock().await;
    if let Some(ref mut stdin) = *stdin_guard {
        if !body.is_empty() {
            let _ = stdin.write_all(&body).await;
        }
        if close_stdin {
            stdin.close();
            *stdin_guard = None;
        }
    }

    StatusCode::NO_CONTENT.into_response()
}

pub(in crate::commands::serve) async fn send_signal(
    State(state): State<Arc<AppState>>,
    Path((_box_id, exec_id)): Path<(String, String)>,
    Json(req): Json<SignalRequest>,
) -> Response {
    let executions = state.executions.read().await;
    let active = match executions.get(&exec_id) {
        Some(a) => a,
        None => {
            return error_response(
                StatusCode::NOT_FOUND,
                format!("execution not found: {exec_id}"),
                "NotFoundError",
            );
        }
    };

    match active.execution.signal(req.signal).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            error_response(status, e.to_string(), etype)
        }
    }
}

pub(in crate::commands::serve) async fn resize_tty(
    State(state): State<Arc<AppState>>,
    Path((_box_id, exec_id)): Path<(String, String)>,
    Json(req): Json<ResizeRequest>,
) -> Response {
    let executions = state.executions.read().await;
    let active = match executions.get(&exec_id) {
        Some(a) => a,
        None => {
            return error_response(
                StatusCode::NOT_FOUND,
                format!("execution not found: {exec_id}"),
                "NotFoundError",
            );
        }
    };

    match active.execution.resize_tty(req.rows, req.cols).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            error_response(status, e.to_string(), etype)
        }
    }
}
