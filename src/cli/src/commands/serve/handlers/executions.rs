//! Execution handlers: start, status, signal, resize, kill, attach.

use std::sync::Arc;
use std::time::Duration;

use axum::Json;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures::SinkExt;
use futures::StreamExt;

use super::super::types::{ExecRequest, ExecResponse, ResizeRequest, SignalRequest};
use super::super::{
    ActiveExecution, AppState, build_box_command, classify_boxlite_error, error_response,
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

    let mut stdin = execution.stdin();
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
    let active = ActiveExecution::new(box_id, execution, stdin);

    state
        .executions
        .write()
        .await
        .insert(exec_id.clone(), active);

    (
        StatusCode::CREATED,
        Json(ExecResponse {
            execution_id: exec_id,
        }),
    )
        .into_response()
}

// `Response` carries axum's boxed body which is wide enough to trip
// clippy's `result_large_err`. Error paths are rare lookups so boxing
// every Err is more cost than it saves.
#[allow(clippy::result_large_err)]
fn get_active_for_box(
    executions: &std::collections::HashMap<String, Arc<ActiveExecution>>,
    exec_id: &str,
    box_id: &str,
) -> Result<Arc<ActiveExecution>, Response> {
    match executions.get(exec_id).cloned() {
        Some(active) if active.box_id() == box_id => Ok(active),
        Some(_) => Err(error_response(
            StatusCode::NOT_FOUND,
            format!("execution not found: {exec_id}"),
            "NotFoundError",
        )),
        None => Err(error_response(
            StatusCode::NOT_FOUND,
            format!("execution not found: {exec_id}"),
            "NotFoundError",
        )),
    }
}

pub(in crate::commands::serve) async fn get_execution(
    State(state): State<Arc<AppState>>,
    Path((box_id, exec_id)): Path<(String, String)>,
) -> Response {
    let executions = state.executions.read().await;
    let active = match get_active_for_box(&executions, &exec_id, &box_id) {
        Ok(a) => a,
        Err(resp) => return resp,
    };
    drop(executions);

    let (status, exit_code) = if active.is_done() {
        ("completed", Some(active.exit_code()))
    } else {
        ("running", None)
    };

    let mut body = serde_json::json!({
        "execution_id": exec_id,
        "status": status,
    });
    if let Some(code) = exit_code {
        body["exit_code"] = serde_json::json!(code);
    }
    Json(body).into_response()
}

/// Whitelist of cooperative signals (Phase 2.3 parity). SIGKILL goes
/// through `DELETE /executions/{id}`; STOP/CONT variants are rejected
/// because they bypass PTY line discipline.
const ALLOWED_SIGNALS: &[i32] = &[1, 2, 3, 6, 10, 12, 15, 28];

pub(in crate::commands::serve) async fn send_signal(
    State(state): State<Arc<AppState>>,
    Path((box_id, exec_id)): Path<(String, String)>,
    Json(req): Json<SignalRequest>,
) -> Response {
    if !ALLOWED_SIGNALS.contains(&req.signal) {
        return error_response(
            StatusCode::BAD_REQUEST,
            format!(
                "signal {} not allowed; use DELETE /executions/{{id}} for kill, \
                 cooperative signals are {:?}",
                req.signal, ALLOWED_SIGNALS
            ),
            "ValidationError",
        );
    }

    let executions = state.executions.read().await;
    let active = match get_active_for_box(&executions, &exec_id, &box_id) {
        Ok(a) => a,
        Err(resp) => return resp,
    };
    drop(executions);

    let sig_result = tokio::time::timeout(
        Duration::from_secs(10),
        active.execution().signal(req.signal),
    )
    .await;
    match sig_result {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(e)) => {
            let (status, etype) = classify_boxlite_error(&e);
            error_response(status, e.to_string(), etype)
        }
        Err(_) => error_response(
            StatusCode::GATEWAY_TIMEOUT,
            "signal delivery timed out",
            "TimeoutError",
        ),
    }
}

/// Kill an execution (SIGKILL) and remove it from the registry.
/// Marks the exec as doomed first so concurrent attach/signal operations
/// are blocked, then delivers the kill, and finally evicts from the map.
pub(in crate::commands::serve) async fn kill_execution(
    State(state): State<Arc<AppState>>,
    Path((box_id, exec_id)): Path<(String, String)>,
) -> Response {
    let active = {
        let executions = state.executions.read().await;
        match get_active_for_box(&executions, &exec_id, &box_id) {
            Ok(a) => a,
            Err(resp) => return resp,
        }
    };

    active.mark_reaping_kill().await;

    let kill_result =
        tokio::time::timeout(Duration::from_secs(10), active.execution().kill()).await;
    match kill_result {
        Ok(Ok(())) => {
            state.executions.write().await.remove(&exec_id);
            StatusCode::NO_CONTENT.into_response()
        }
        Ok(Err(e)) => {
            let (status, etype) = classify_boxlite_error(&e);
            error_response(status, e.to_string(), etype)
        }
        Err(_) => error_response(
            StatusCode::GATEWAY_TIMEOUT,
            "kill timed out; the reaper will retry",
            "TimeoutError",
        ),
    }
}

pub(in crate::commands::serve) async fn resize_tty(
    State(state): State<Arc<AppState>>,
    Path((box_id, exec_id)): Path<(String, String)>,
    Json(req): Json<ResizeRequest>,
) -> Response {
    let executions = state.executions.read().await;
    let active = match get_active_for_box(&executions, &exec_id, &box_id) {
        Ok(a) => a,
        Err(resp) => return resp,
    };
    drop(executions);

    match active.execution().resize_tty(req.rows, req.cols).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => {
            let (status, etype) = classify_boxlite_error(&e);
            error_response(status, e.to_string(), etype)
        }
    }
}

// ============================================================================
// /attach — bidirectional WebSocket
// ============================================================================
//
// One persistent WS carries stdin (Binary frames in), stdout/stderr (Binary
// frames out with 1-byte channel prefix: 0x01=stdout, 0x02=stderr), and
// control messages (Text JSON: resize/signal/stdin_eof in; exit/error out).
// Mirrors the Go runner's `/attach` wire format so the SDK speaks one
// protocol regardless of which runtime backs the request.

const ATTACH_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
const ATTACH_WRITE_TIMEOUT: Duration = Duration::from_secs(20);

pub(in crate::commands::serve) async fn attach_execution(
    State(state): State<Arc<AppState>>,
    Path((box_id, exec_id)): Path<(String, String)>,
    ws: WebSocketUpgrade,
) -> Response {
    let executions = state.executions.read().await;
    let active = match get_active_for_box(&executions, &exec_id, &box_id) {
        Ok(a) => a,
        Err(resp) => return resp,
    };
    drop(executions);

    // Claim BEFORE the HTTP upgrade so rejection is a proper 409 at the
    // HTTP level.
    if !active.mark_connected().await {
        return error_response(
            StatusCode::CONFLICT,
            format!("execution {} already has an attached client", exec_id),
            "ConflictError",
        );
    }

    // If Hyper fails the upgrade (client drops mid-handshake), release
    // the slot so the exec is reattachable / reapable.
    let failed_active = Arc::clone(&active);
    ws.on_failed_upgrade(move |_err| {
        tokio::spawn(async move {
            failed_active.mark_disconnected().await;
        });
    })
    .on_upgrade(move |socket| async move {
        run_attach_session(socket, active).await;
    })
}

async fn run_attach_session(socket: WebSocket, active: Arc<ActiveExecution>) {
    let mut stdout_rx = active.stdout_bus().subscribe();
    let mut stderr_rx = active.stderr_bus().subscribe();
    let mut done_rx = active.done_rx();
    let (mut sink, mut stream) = socket.split();

    // Channel for control-response frames from the reader task back
    // to the writer task (e.g. error frames for rejected signals).
    let (ctrl_tx, mut ctrl_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    let reader_active = Arc::clone(&active);
    let mut reader = tokio::spawn(async move {
        while let Some(msg) = stream.next().await {
            match msg {
                Ok(Message::Binary(bytes)) => {
                    let mut guard = reader_active.stdin().lock().await;
                    if let Some(ref mut stdin) = *guard
                        && let Err(e) = stdin.write_all(&bytes).await
                    {
                        let _ = ctrl_tx.send(
                            serde_json::json!({
                                "type": "error",
                                "message": format!("stdin write failed: {e}"),
                            })
                            .to_string(),
                        );
                    }
                }
                Ok(Message::Text(text)) => {
                    let v = match serde_json::from_str::<serde_json::Value>(&text) {
                        Ok(v) => v,
                        Err(e) => {
                            let _ = ctrl_tx.send(
                                serde_json::json!({
                                    "type": "error",
                                    "message": format!("invalid control frame: {e}"),
                                })
                                .to_string(),
                            );
                            continue;
                        }
                    };
                    match v.get("type").and_then(|t| t.as_str()) {
                        Some("resize") => {
                            let rows =
                                match v.get("rows").and_then(|n| n.as_u64()) {
                                    Some(r) if r > 0 => r as u32,
                                    _ => {
                                        let _ = ctrl_tx.send(serde_json::json!({
                                        "type": "error",
                                        "message": "resize: 'rows' must be a positive integer",
                                    }).to_string());
                                        continue;
                                    }
                                };
                            let cols =
                                match v.get("cols").and_then(|n| n.as_u64()) {
                                    Some(c) if c > 0 => c as u32,
                                    _ => {
                                        let _ = ctrl_tx.send(serde_json::json!({
                                        "type": "error",
                                        "message": "resize: 'cols' must be a positive integer",
                                    }).to_string());
                                        continue;
                                    }
                                };
                            if let Err(e) = reader_active.execution().resize_tty(rows, cols).await {
                                let _ = ctrl_tx.send(
                                    serde_json::json!({
                                        "type": "error",
                                        "message": format!("resize failed: {e}"),
                                    })
                                    .to_string(),
                                );
                            }
                        }
                        Some("signal") => {
                            let sig =
                                match v.get("sig").and_then(|n| n.as_i64()) {
                                    Some(s) if s > 0 => s as i32,
                                    _ => {
                                        let _ = ctrl_tx.send(serde_json::json!({
                                        "type": "error",
                                        "message": "signal: 'sig' must be a positive integer",
                                    }).to_string());
                                        continue;
                                    }
                                };
                            if !ALLOWED_SIGNALS.contains(&sig) {
                                let _ = ctrl_tx.send(
                                    serde_json::json!({
                                        "type": "error",
                                        "message": format!(
                                            "signal {} not allowed; whitelist: {:?}",
                                            sig, ALLOWED_SIGNALS
                                        ),
                                    })
                                    .to_string(),
                                );
                            } else if let Err(e) = reader_active.execution().signal(sig).await {
                                let _ = ctrl_tx.send(
                                    serde_json::json!({
                                        "type": "error",
                                        "message": format!("signal {} failed: {e}", sig),
                                    })
                                    .to_string(),
                                );
                            }
                        }
                        Some("stdin_eof") => {
                            let mut guard = reader_active.stdin().lock().await;
                            if let Some(ref mut stdin) = *guard {
                                stdin.close();
                            }
                            *guard = None;
                        }
                        Some(unknown) => {
                            let _ = ctrl_tx.send(
                                serde_json::json!({
                                    "type": "error",
                                    "message": format!("unknown control type: {unknown}"),
                                })
                                .to_string(),
                            );
                        }
                        None => {
                            let _ = ctrl_tx.send(
                                serde_json::json!({
                                    "type": "error",
                                    "message": "control frame missing 'type' field",
                                })
                                .to_string(),
                            );
                        }
                    }
                }
                Ok(Message::Close(_)) => break,
                Ok(_) => {}
                Err(_) => break,
            }
        }
    });

    let writer_active = Arc::clone(&active);
    let mut ping_interval = tokio::time::interval(ATTACH_KEEPALIVE_INTERVAL);
    ping_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut writer = tokio::spawn(async move {
        async fn ws_send<S>(sink: &mut S, msg: Message) -> bool
        where
            S: SinkExt<Message> + Unpin,
        {
            matches!(
                tokio::time::timeout(ATTACH_WRITE_TIMEOUT, sink.send(msg)).await,
                Ok(Ok(_))
            )
        }

        // Helper macro: drain buffered stdout/stderr and send to the WS.
        macro_rules! drain_backlog {
            ($sink:expr, $stdout_rx:expr, $stderr_rx:expr) => {{
                while let Ok(bytes) = $stdout_rx.try_recv() {
                    let mut framed = Vec::with_capacity(bytes.len() + 1);
                    framed.push(0x01u8);
                    framed.extend_from_slice(&bytes);
                    if !ws_send($sink, Message::Binary(framed.into())).await {
                        break;
                    }
                }
                while let Ok(bytes) = $stderr_rx.try_recv() {
                    let mut framed = Vec::with_capacity(bytes.len() + 1);
                    framed.push(0x02u8);
                    framed.extend_from_slice(&bytes);
                    if !ws_send($sink, Message::Binary(framed.into())).await {
                        break;
                    }
                }
            }};
        }

        // Fast path: process already exited before WS connected.
        // done.store(true) is set after all stdout/stderr pumps finish,
        // so the backlog has every byte the process ever wrote.
        // We skip the select loop entirely — done_rx.changed() would
        // never fire because watch::subscribe() marks the current value
        // as seen, and done_tx.send(true) may have already happened.
        if !writer_active.is_done() {
            loop {
                tokio::select! {
                    msg = stdout_rx.recv() => match msg {
                        Ok(bytes) => {
                            let mut framed = Vec::with_capacity(bytes.len() + 1);
                            framed.push(0x01u8);
                            framed.extend_from_slice(&bytes);
                            if !ws_send(&mut sink, Message::Binary(framed.into())).await {
                                break;
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        Err(_) => continue,
                    },
                    msg = stderr_rx.recv() => match msg {
                        Ok(bytes) => {
                            let mut framed = Vec::with_capacity(bytes.len() + 1);
                            framed.push(0x02u8);
                            framed.extend_from_slice(&bytes);
                            if !ws_send(&mut sink, Message::Binary(framed.into())).await {
                                break;
                            }
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        Err(_) => continue,
                    },
                    ctrl = ctrl_rx.recv() => if let Some(text) = ctrl
                        && !ws_send(&mut sink, Message::Text(text.into())).await
                    {
                        break;
                    },
                    _ = ping_interval.tick() => {
                        if !ws_send(&mut sink, Message::Ping(Vec::<u8>::new().into())).await {
                            break;
                        }
                    }
                    changed = done_rx.changed() => {
                        if changed.is_ok() {
                            drain_backlog!(&mut sink, &mut stdout_rx, &mut stderr_rx);
                        }
                        break;
                    }
                }
            }
        } else {
            drain_backlog!(&mut sink, &mut stdout_rx, &mut stderr_rx);
        }

        if writer_active.is_done() {
            let exit = serde_json::json!({
                "type": "exit",
                "exit_code": writer_active.exit_code(),
            });
            let _ = ws_send(&mut sink, Message::Text(exit.to_string().into())).await;
            let _ = ws_send(&mut sink, Message::Close(None)).await;
        }
    });

    // Canonical axum bidi WS pattern (examples/websockets/src/main.rs:180-195):
    // whichever task completes first aborts the other so a wedged peer can't
    // pin the attach slot. Without this, a half-dead client could keep the
    // reader parked on conn.recv() for minutes (TCP read doesn't notice a
    // dead peer until keepalive timeout), blocking reattach and the reaper.
    //
    // NOTE: do NOT `.await` the handle that won the select — select! polled
    // it to completion, and a second poll on a finished JoinHandle panics
    // with "JoinHandle polled after completion". Only join the aborted side
    // so its task wind-down completes before mark_disconnected runs.
    let aborted = tokio::select! {
        _ = &mut reader => { writer.abort(); writer }
        _ = &mut writer => { reader.abort(); reader }
    };
    let _ = aborted.await;
    active.mark_disconnected().await;
}
