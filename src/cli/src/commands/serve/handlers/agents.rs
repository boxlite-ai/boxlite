//! Agent REST operations backed by the Box-owned agent API.

use std::convert::Infallible;
use std::sync::Arc;

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use boxlite::agents::{
    self, AgentControlOptions, AgentCreateOptions, AgentEventsOptions, AgentSendMode,
    AgentSendOptions, AgentTurnStatus,
};
use boxlite::{Agent, BoxStatus, BoxliteError};
use futures::StreamExt;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde::Deserialize;
use serde_json::{Value, json};

use super::super::{
    AGENT_STOPPING, AgentReservation, AppState, error_from_boxlite, get_or_resume_box,
};

const UNCERTAIN_ADMISSION_GRACE: std::time::Duration = std::time::Duration::from_secs(300);
static NEXT_RESERVATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn optional_non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateOptions {
    #[serde(default, deserialize_with = "optional_non_null")]
    cwd: Option<String>,
    #[serde(default, deserialize_with = "optional_non_null")]
    config: Option<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CreateRequest {
    agent: String,
    #[serde(default)]
    options: CreateOptions,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct SendOptions {
    #[serde(default, deserialize_with = "optional_non_null")]
    mode: Option<String>,
    #[serde(default, deserialize_with = "optional_non_null")]
    data: Option<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SendRequest {
    text: String,
    #[serde(default)]
    options: SendOptions,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TextRequest {
    text: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RespondRequest {
    response: Value,
}

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct EmptyRequest {}

#[derive(Deserialize)]
pub(in crate::commands::serve) struct EventQuery {
    turn_id: Option<String>,
    after: Option<String>,
}

fn decode<T: for<'de> Deserialize<'de>>(body: &Bytes) -> Result<T, BoxliteError> {
    serde_json::from_slice(body).map_err(|error| BoxliteError::InvalidArgument(error.to_string()))
}

fn empty_body(body: &Bytes) -> Result<(), BoxliteError> {
    if body.is_empty() {
        return Ok(());
    }
    decode::<EmptyRequest>(body).map(|_| ())
}

fn key(headers: &HeaderMap) -> Result<Option<String>, BoxliteError> {
    let mut values = headers.get_all("Idempotency-Key").iter();
    let Some(value) = values.next() else {
        return Ok(None);
    };
    let bytes = value.as_bytes();
    if values.next().is_some()
        || bytes.is_empty()
        || bytes.len() > 256
        || !bytes.iter().all(|byte| (b'!'..=b'~').contains(byte))
    {
        return Err(BoxliteError::InvalidArgument(
            "invalid Idempotency-Key".into(),
        ));
    }
    Ok(Some(
        String::from_utf8(bytes.to_vec()).expect("visible ASCII"),
    ))
}

#[allow(clippy::result_large_err)]
async fn open(state: &AppState, box_id: &str, agent_id: &str) -> Result<Agent, Response> {
    let sandbox = get_or_resume_box(state, box_id).await?;
    sandbox
        .agents()
        .get(agent_id)
        .await
        .map_err(|error| error_from_boxlite(&error))
}

fn snapshot(agent: &Agent) -> Result<Value, BoxliteError> {
    let state = match agent.state() {
        Ok(state) => agents::records::agent_state(&state),
        Err(BoxliteError::Unsupported(_)) => Value::Null,
        Err(error) => return Err(error),
    };
    Ok(
        json!({"id": agent.id(), "agent": agent.implementation(), "state": state,
        "config": agents::records::config(&agent.config()?),
        "capabilities": agents::records::capabilities(&agent.capabilities()?)}),
    )
}

fn release_turn(
    turns: &mut std::collections::HashMap<String, AgentReservation>,
    box_id: &str,
    generation: u64,
) {
    if let Some(reservation) = turns.get_mut(box_id) {
        if reservation.generation != generation || reservation.count == AGENT_STOPPING {
            return;
        }
        reservation.count -= 1;
        if reservation.count == 0 {
            turns.remove(box_id);
        }
    }
}

fn observe_turn(
    state: Arc<AppState>,
    box_id: String,
    generation: u64,
    agent: Agent,
    turn_id: String,
) {
    tokio::spawn(async move {
        loop {
            if !state
                .agent_turns
                .lock()
                .await
                .get(&box_id)
                .is_some_and(|turn| turn.generation == generation)
            {
                return;
            }
            // Metadata reads cannot start the service or reuse the spent handle.
            match state.runtime.get_info(&box_id).await {
                Ok(Some(info)) if info.status.is_running() => {
                    if let Ok(turn) = agent.get_turn(&turn_id).await
                        && let Ok(snapshot) = turn.state()
                        && matches!(
                            snapshot.status,
                            AgentTurnStatus::Completed
                                | AgentTurnStatus::Cancelled
                                | AgentTurnStatus::Failed
                                | AgentTurnStatus::Unknown
                        )
                    {
                        break;
                    }
                }
                Ok(Some(info)) if matches!(info.status, BoxStatus::Paused | BoxStatus::Unknown) => {
                }
                Err(_) => {}
                Ok(_) => break,
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        let mut turns = state.agent_turns.lock().await;
        release_turn(&mut turns, &box_id, generation);
    });
}

fn location(box_id: &str, agent_id: &str, turn_id: Option<&str>) -> String {
    let mut path = format!(
        "/v1/boxes/{}/agents/{}",
        utf8_percent_encode(box_id, NON_ALPHANUMERIC),
        utf8_percent_encode(agent_id, NON_ALPHANUMERIC)
    );
    if let Some(turn_id) = turn_id {
        path.push_str(&format!(
            "/turns/{}",
            utf8_percent_encode(turn_id, NON_ALPHANUMERIC)
        ));
    }
    path
}

pub(in crate::commands::serve) async fn create(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let request: CreateRequest = match decode(&body) {
        Ok(v) => v,
        Err(e) => return error_from_boxlite(&e),
    };
    let key = match key(&headers) {
        Ok(v) => v,
        Err(e) => return error_from_boxlite(&e),
    };
    let config = match request.options.config {
        Some(value) => match agents::records::parse_config(value) {
            Ok(v) => v,
            Err(e) => return error_from_boxlite(&e),
        },
        None => Default::default(),
    };
    let sandbox = match get_or_resume_box(&state, &box_id).await {
        Ok(v) => v,
        Err(e) => return e,
    };
    match sandbox
        .agents()
        .create(
            &request.agent,
            AgentCreateOptions {
                cwd: request.options.cwd,
                config,
                idempotency_key: key,
            },
        )
        .await
    {
        Ok(agent) => match snapshot(&agent) {
            Ok(body) => (
                StatusCode::CREATED,
                [(header::LOCATION, location(&box_id, agent.id(), None))],
                Json(body),
            )
                .into_response(),
            Err(error) => error_from_boxlite(&error),
        },
        Err(error) => error_from_boxlite(&error),
    }
}

pub(in crate::commands::serve) async fn get(
    State(state): State<Arc<AppState>>,
    Path((box_id, agent_id)): Path<(String, String)>,
) -> Response {
    let agent = match open(&state, &box_id, &agent_id).await {
        Ok(v) => v,
        Err(e) => return e,
    };
    match snapshot(&agent) {
        Ok(body) => Json(body).into_response(),
        Err(error) => error_from_boxlite(&error),
    }
}

pub(in crate::commands::serve) async fn close(
    State(state): State<Arc<AppState>>,
    Path((box_id, agent_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(e) = empty_body(&body) {
        return error_from_boxlite(&e);
    }
    let idempotency_key = match key(&headers) {
        Ok(v) => v,
        Err(e) => return error_from_boxlite(&e),
    };
    let agent = match open(&state, &box_id, &agent_id).await {
        Ok(v) => v,
        Err(e) => return e,
    };
    match agent.close(AgentControlOptions { idempotency_key }).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => error_from_boxlite(&e),
    }
}

pub(in crate::commands::serve) async fn send(
    State(state): State<Arc<AppState>>,
    Path((box_id, agent_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let request: SendRequest = match decode(&body) {
        Ok(v) => v,
        Err(e) => return error_from_boxlite(&e),
    };
    let idempotency_key = match key(&headers) {
        Ok(v) => v,
        Err(e) => return error_from_boxlite(&e),
    };
    let mode = match request.options.mode.as_deref() {
        None | Some("queue") => AgentSendMode::Queue,
        Some("reject") => AgentSendMode::Reject,
        Some(_) => {
            return error_from_boxlite(&BoxliteError::InvalidArgument("invalid send mode".into()));
        }
    };
    // The task owns admission even if the HTTP client disconnects.
    match tokio::spawn(async move {
        let canonical = match state.runtime.get_info(&box_id).await {
            Ok(Some(info)) => info.id.to_string(),
            Ok(None) => {
                return error_from_boxlite(&BoxliteError::NotFound(format!(
                    "box {box_id} not found"
                )));
            }
            Err(error) => return error_from_boxlite(&error),
        };
        let generation = loop {
            let mut turns = state.agent_turns.lock().await;
            if !turns
                .get(&canonical)
                .is_some_and(|turn| turn.count == AGENT_STOPPING)
            {
                let turn = turns
                    .entry(canonical.clone())
                    .or_insert_with(|| AgentReservation {
                        count: 0,
                        generation: NEXT_RESERVATION
                            .fetch_add(1, std::sync::atomic::Ordering::Relaxed),
                    });
                turn.count += 1;
                break turn.generation;
            }
            drop(turns);
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        };
        let agent = match open(&state, &canonical, &agent_id).await {
            Ok(agent) => agent,
            Err(response) => {
                let mut turns = state.agent_turns.lock().await;
                release_turn(&mut turns, &canonical, generation);
                return response;
            }
        };
        match agent
            .send(
                &request.text,
                AgentSendOptions {
                    mode,
                    data: request.options.data,
                    idempotency_key,
                },
            )
            .await
        {
            Ok(turn) => match turn.state() {
                Ok(snapshot) => {
                    observe_turn(
                        Arc::clone(&state),
                        canonical,
                        generation,
                        agent,
                        snapshot.id.clone(),
                    );
                    (
                        StatusCode::CREATED,
                        [(
                            header::LOCATION,
                            location(&box_id, &agent_id, Some(&snapshot.id)),
                        )],
                        Json(agents::records::turn_state(&snapshot)),
                    )
                        .into_response()
                }
                Err(error) => error_from_boxlite(&error),
            },
            Err(error) => {
                if matches!(
                    error,
                    BoxliteError::InvalidArgument(_)
                        | BoxliteError::Unsupported(_)
                        | BoxliteError::NotFound(_)
                        | BoxliteError::AlreadyExists(_)
                        | BoxliteError::InvalidState(_)
                        | BoxliteError::ResourceExhausted(_)
                        | BoxliteError::Config(_)
                        | BoxliteError::Stopped(_)
                ) {
                    let mut turns = state.agent_turns.lock().await;
                    release_turn(&mut turns, &canonical, generation);
                } else {
                    let deadline = tokio::time::Instant::now() + UNCERTAIN_ADMISSION_GRACE;
                    tokio::spawn(async move {
                        tokio::time::sleep_until(deadline).await;
                        let mut turns = state.agent_turns.lock().await;
                        release_turn(&mut turns, &canonical, generation);
                    });
                }
                error_from_boxlite(&error)
            }
        }
    })
    .await
    {
        Ok(response) => response,
        Err(error) => error_from_boxlite(&BoxliteError::Internal(format!(
            "agent admission task failed: {error}"
        ))),
    }
}

pub(in crate::commands::serve) async fn get_turn(
    State(state): State<Arc<AppState>>,
    Path((box_id, agent_id, turn_id)): Path<(String, String, String)>,
) -> Response {
    let agent = match open(&state, &box_id, &agent_id).await {
        Ok(v) => v,
        Err(e) => return e,
    };
    match agent.get_turn(&turn_id).await.and_then(|turn| turn.state()) {
        Ok(snapshot) => Json(agents::records::turn_state(&snapshot)).into_response(),
        Err(e) => error_from_boxlite(&e),
    }
}

pub(in crate::commands::serve) async fn respond(
    State(state): State<Arc<AppState>>,
    Path((box_id, agent_id, request_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let request: RespondRequest = match decode(&body) {
        Ok(v) => v,
        Err(e) => return error_from_boxlite(&e),
    };
    let response = match agents::records::parse_response(request.response) {
        Ok(v) => v,
        Err(e) => return error_from_boxlite(&e),
    };
    let idempotency_key = match key(&headers) {
        Ok(v) => v,
        Err(e) => return error_from_boxlite(&e),
    };
    let agent = match open(&state, &box_id, &agent_id).await {
        Ok(v) => v,
        Err(e) => return e,
    };
    match agent
        .respond(
            &request_id,
            response,
            AgentControlOptions { idempotency_key },
        )
        .await
        .and_then(|turn| turn.state())
    {
        Ok(snapshot) => Json(agents::records::turn_state(&snapshot)).into_response(),
        Err(e) => error_from_boxlite(&e),
    }
}

pub(in crate::commands::serve) async fn steer(
    State(state): State<Arc<AppState>>,
    Path((box_id, agent_id, turn_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let request: TextRequest = match decode(&body) {
        Ok(v) => v,
        Err(e) => return error_from_boxlite(&e),
    };
    let idempotency_key = match key(&headers) {
        Ok(v) => v,
        Err(e) => return error_from_boxlite(&e),
    };
    let agent = match open(&state, &box_id, &agent_id).await {
        Ok(v) => v,
        Err(e) => return e,
    };
    let turn = match agent.get_turn(&turn_id).await {
        Ok(v) => v,
        Err(e) => return error_from_boxlite(&e),
    };
    match turn
        .steer(&request.text, AgentControlOptions { idempotency_key })
        .await
    {
        Ok(receipt) => Json(agents::records::receipt(&receipt)).into_response(),
        Err(e) => error_from_boxlite(&e),
    }
}

pub(in crate::commands::serve) async fn interrupt(
    State(state): State<Arc<AppState>>,
    Path((box_id, agent_id, turn_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if let Err(e) = empty_body(&body) {
        return error_from_boxlite(&e);
    }
    let idempotency_key = match key(&headers) {
        Ok(v) => v,
        Err(e) => return error_from_boxlite(&e),
    };
    let agent = match open(&state, &box_id, &agent_id).await {
        Ok(v) => v,
        Err(e) => return e,
    };
    let turn = match agent.get_turn(&turn_id).await {
        Ok(v) => v,
        Err(e) => return error_from_boxlite(&e),
    };
    match turn
        .interrupt(AgentControlOptions { idempotency_key })
        .await
    {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => error_from_boxlite(&e),
    }
}

pub(in crate::commands::serve) async fn events(
    State(state): State<Arc<AppState>>,
    Path((box_id, agent_id)): Path<(String, String)>,
    headers: HeaderMap,
    Query(query): Query<EventQuery>,
) -> Response {
    let after = match headers.get("Last-Event-ID") {
        Some(value) => match value.to_str() {
            Ok(v) => Some(v.to_owned()),
            Err(_) => {
                return error_from_boxlite(&BoxliteError::InvalidArgument(
                    "invalid Last-Event-ID".into(),
                ));
            }
        },
        None => query.after,
    };
    let agent = match open(&state, &box_id, &agent_id).await {
        Ok(v) => v,
        Err(e) => return e,
    };
    let options = AgentEventsOptions { after };
    let stream = match query.turn_id {
        Some(turn_id) => match agent.get_turn(&turn_id).await {
            Ok(turn) => turn.events(options).await,
            Err(e) => Err(e),
        },
        None => agent.events(options).await,
    };
    let stream = match stream {
        Ok(v) => v,
        Err(e) => return error_from_boxlite(&e),
    };
    let events = futures::stream::unfold((stream, false), |(mut stream, ended)| async move {
        if ended {
            return None;
        }
        let item = stream.next().await?;
        let item = item.and_then(|item| {
            if item
                .cursor
                .as_deref()
                .is_some_and(|value| value.contains(['\r', '\n', '\0']))
            {
                Err(BoxliteError::Internal(
                    "agent event has an invalid cursor".into(),
                ))
            } else {
                Ok(item)
            }
        });
        let ended = item.is_err();
        let event = match item {
            Ok(item) => {
                let mut event = Event::default()
                    .event("agent")
                    .data(agents::records::event(&item).to_string());
                if let Some(cursor) = item.cursor {
                    event = event.id(cursor);
                }
                event
            }
            Err(error) => {
                let (_, kind, code) = error.http();
                Event::default().event("error").data(
                    json!({"error": {"message": error.to_string(), "type": kind, "code": code}})
                        .to_string(),
                )
            }
        };
        Some((Ok::<_, Infallible>(event), (stream, ended)))
    });
    Sse::new(events)
        .keep_alive(KeepAlive::new().text("keepalive"))
        .into_response()
}
