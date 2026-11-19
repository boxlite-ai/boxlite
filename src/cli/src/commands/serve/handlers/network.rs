use super::super::{AppState, error_from_boxlite, error_response, get_or_fetch_box};
use axum::{
    Json,
    extract::{Path, State, rejection::JsonRejection},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use boxlite::net::{
    OutboundReplaceOutcome, OutboundReplacement, OutboundRevision, OutboundSnapshot,
};
use boxlite::runtime::options::{InboundNetworkConfig, OutboundNetworkConfig};
use std::sync::Arc;

#[path = "outbound_precondition.rs"]
mod precondition;

// `Response` is wide enough to trip clippy's `result_large_err`; see
// `get_active_for_box` in executions.rs.
#[allow(clippy::result_large_err)]
fn policy_body<T>(body: Result<Json<T>, JsonRejection>) -> Result<T, Response> {
    body.map(|Json(policy)| policy).map_err(|error| {
        error_from_boxlite(&boxlite::BoxliteError::InvalidArgument(error.body_text()))
    })
}

pub(in crate::commands::serve) async fn set_inbound(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    body: Result<Json<InboundNetworkConfig>, JsonRejection>,
) -> Response {
    let config = match policy_body(body) {
        Ok(config) => config,
        Err(error) => return error,
    };
    let handle = match get_or_fetch_box(&state, &box_id).await {
        Ok(handle) => handle,
        Err(error) => return error,
    };
    match handle.network().update_inbound(config.clone()).await {
        Ok(()) => Json(config).into_response(),
        Err(error) => error_from_boxlite(&error),
    }
}

pub(in crate::commands::serve) async fn set_outbound(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    headers: HeaderMap,
    body: Result<Json<OutboundNetworkConfig>, JsonRejection>,
) -> Response {
    let config = match policy_body(body) {
        Ok(config) => config,
        Err(error) => return error,
    };
    if let Err(error) = config.validate() {
        return error_from_boxlite(&error);
    }
    if headers.contains_key("x-boxlite-outbound-revision") {
        return invalid("coordinator metadata requires the snapshot resource");
    }
    let handle = match get_or_fetch_box(&state, &box_id).await {
        Ok(handle) => handle,
        Err(error) => return error,
    };
    let network = handle.network();
    if headers.contains_key(header::IF_MATCH) {
        return replace_conditionally(&network, config, &headers).await;
    }
    match network.update_outbound(config.clone()).await {
        Ok(()) => Json(config).into_response(),
        Err(error) => error_from_boxlite(&error),
    }
}

async fn replace_conditionally(
    network: &boxlite::litebox::NetworkHandle,
    policy: OutboundNetworkConfig,
    headers: &HeaderMap,
) -> Response {
    let candidate = OutboundSnapshot {
        policy,
        revision: OutboundRevision::fresh(),
    };
    // Only an explicit CAS refusal permits retry. Recheck the complete public
    // predicate because a tag list or wildcard may still match the new revision.
    for _ in 0..2 {
        let current = match network.outbound_snapshot().await {
            Ok(value) => value,
            Err(error) => return error_from_boxlite(&error),
        };
        match precondition::matches(headers, &current.revision) {
            Ok(false) => {
                return error_response(
                    StatusCode::PRECONDITION_FAILED,
                    "outbound revision does not match If-Match",
                    "PreconditionFailedError",
                    "precondition_failed",
                );
            }
            Err(error) => return invalid(error),
            Ok(true) => {}
        }
        let replacement = match OutboundReplacement::new(current.revision, candidate.clone()) {
            Ok(value) => value,
            Err(error) => return error_from_boxlite(&error),
        };
        match network.replace_outbound_snapshot(replacement).await {
            Ok(OutboundReplaceOutcome::Applied) => return policy_reply(candidate),
            Ok(OutboundReplaceOutcome::PreconditionFailed) => continue,
            Err(error) => return error_from_boxlite(&error),
        }
    }
    error_from_boxlite(&boxlite::BoxliteError::InvalidState(
        "outbound policy changed concurrently; retry the complete replacement".into(),
    ))
}

fn invalid(message: &str) -> Response {
    error_from_boxlite(&boxlite::BoxliteError::InvalidArgument(message.into()))
}

pub(in crate::commands::serve) async fn published_ports(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
) -> Response {
    let handle = match get_or_fetch_box(&state, &box_id).await {
        Ok(handle) => handle,
        Err(error) => return error,
    };
    match handle.network().published_ports().await {
        Ok(ports) => Json(ports).into_response(),
        Err(error) => error_from_boxlite(&error),
    }
}

fn policy_reply(snapshot: OutboundSnapshot) -> Response {
    (
        [(header::ETAG, format!("\"{}\"", snapshot.revision))],
        Json(snapshot.policy),
    )
        .into_response()
}

pub(in crate::commands::serve) async fn get_outbound(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
) -> Response {
    let handle = match get_or_fetch_box(&state, &box_id).await {
        Ok(value) => value,
        Err(error) => return error,
    };
    match handle.network().outbound_snapshot().await {
        Ok(snapshot) => policy_reply(snapshot),
        Err(error) => error_from_boxlite(&error),
    }
}

#[derive(serde::Serialize)]
struct OutboundStatusReply {
    #[serde(flatten)]
    status: boxlite::net::OutboundStatus,
    runtime_persisted: OutboundSnapshot,
    capabilities: [&'static str; 1],
}

pub(in crate::commands::serve) async fn outbound_status(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
) -> Response {
    let handle = match get_or_fetch_box(&state, &box_id).await {
        Ok(value) => value,
        Err(error) => return error,
    };
    match handle.network().outbound_status().await {
        Ok(status) => Json(OutboundStatusReply {
            runtime_persisted: status.persisted.clone(),
            status,
            capabilities: ["revision-v1"],
        })
        .into_response(),
        Err(error) => error_from_boxlite(&error),
    }
}

fn one_header<'a>(headers: &'a HeaderMap, name: &str) -> Result<&'a str, &'static str> {
    let mut values = headers.get_all(name).iter();
    let value = values.next().ok_or("missing revision metadata")?;
    if values.next().is_some() {
        return Err("ambiguous revision metadata");
    }
    value.to_str().map_err(|_| "invalid revision metadata")
}

pub(in crate::commands::serve) async fn replace_outbound(
    State(state): State<Arc<AppState>>,
    Path(box_id): Path<String>,
    headers: HeaderMap,
    body: Result<Json<OutboundNetworkConfig>, JsonRejection>,
) -> Response {
    let config = match policy_body(body) {
        Ok(value) => value,
        Err(error) => return error,
    };
    let replacement = (|| {
        let tag = one_header(&headers, "if-match")
            .map_err(|e| boxlite::BoxliteError::InvalidArgument(e.into()))?;
        let expected = tag
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .ok_or_else(|| {
                boxlite::BoxliteError::InvalidArgument(
                    "one strong expected revision is required".into(),
                )
            })?;
        let candidate = one_header(&headers, "x-boxlite-outbound-revision")
            .map_err(|e| boxlite::BoxliteError::InvalidArgument(e.into()))?;
        OutboundReplacement::new(
            OutboundRevision::parse(expected)?,
            OutboundSnapshot {
                policy: config,
                revision: OutboundRevision::parse(candidate)?,
            },
        )
    })();
    let replacement = match replacement {
        Ok(value) => value,
        Err(error) => return error_from_boxlite(&error),
    };
    let handle = match get_or_fetch_box(&state, &box_id).await {
        Ok(value) => value,
        Err(error) => return error,
    };
    apply(&handle.network(), replacement).await
}

async fn apply(
    network: &boxlite::litebox::NetworkHandle,
    replacement: OutboundReplacement,
) -> Response {
    let candidate = replacement.candidate().clone();
    match network.replace_outbound_snapshot(replacement).await {
        Ok(OutboundReplaceOutcome::Applied) => policy_reply(candidate),
        Ok(OutboundReplaceOutcome::PreconditionFailed) => {
            StatusCode::PRECONDITION_FAILED.into_response()
        }
        Err(error) => error_from_boxlite(&error),
    }
}
