//! Revision-aware REST control; legacy policy setters keep their existing wire contract.
use super::client::{ApiClient, transport_error};
use super::error::map_http_body;
use crate::net::{
    OutboundApplicationState, OutboundReplaceOutcome, OutboundReplacement, OutboundRevision,
    OutboundSnapshot, OutboundStatus,
};
use crate::runtime::options::OutboundNetworkConfig;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use reqwest::{Method, Response, StatusCode, header};

fn uncertain(reason: impl std::fmt::Display) -> BoxliteError {
    BoxliteError::Network(format!("invalid revisioned outbound response: {reason}"))
}

fn body_error(error: reqwest::Error) -> BoxliteError {
    if error.is_timeout() {
        BoxliteError::Network("outbound control response timed out".into())
    } else {
        uncertain(error)
    }
}

fn revision(response: &Response) -> BoxliteResult<OutboundRevision> {
    let mut values = response.headers().get_all(header::ETAG).iter();
    let value = values.next().ok_or_else(|| uncertain("missing ETag"))?;
    if values.next().is_some() {
        return Err(uncertain("multiple ETags"));
    }
    let value = value.to_str().map_err(uncertain)?;
    let token = value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .ok_or_else(|| uncertain("ETag must be one strong revision"))?;
    OutboundRevision::parse(token).map_err(uncertain)
}

async fn checked(response: Response) -> BoxliteResult<Response> {
    let status = response.status();
    if status == StatusCode::OK {
        return Ok(response);
    }
    let body = response.text().await.map_err(body_error)?;
    if matches!(status.as_u16(), 404 | 405 | 501) {
        // A known resource's structured not-found remains a not-found error.
        let value: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
        if value.pointer("/error/code").is_none() && value.get("code").is_none() {
            return Err(BoxliteError::Unsupported(
                "server does not support revisioned outbound control".into(),
            ));
        }
    }
    Err(map_http_body(status, &body))
}

async fn legacy_reply<T: serde::de::DeserializeOwned>(response: Response) -> BoxliteResult<T> {
    let body = response.bytes().await.map_err(body_error)?;
    let value: serde_json::Value = serde_json::from_slice(&body).map_err(uncertain)?;
    for view in std::iter::once(&value).chain(
        ["persisted", "observed", "runtime_persisted"]
            .into_iter()
            .filter_map(|field| value.get(field)),
    ) {
        let policy = view.get("policy").unwrap_or(view);
        if view.get("outbound_v1").is_some()
            || view.get("complete_snapshot").is_some()
            || view
                .get("admission")
                .is_some_and(|admission| admission.as_str() != Some("legacy"))
            || policy.get("deny_net").is_some()
            || policy
                .get("admission")
                .is_some_and(|admission| admission.as_str() != Some("legacy"))
        {
            return Err(BoxliteError::Unsupported(
                "REST policy requires the complete policy interface".into(),
            ));
        }
    }
    serde_json::from_slice(&body).map_err(uncertain)
}

impl ApiClient {
    pub(super) async fn read_outbound_snapshot(
        &self,
        box_id: &str,
    ) -> BoxliteResult<OutboundSnapshot> {
        let response = self
            .outbound_request(Method::GET, &format!("/boxes/{box_id}/network/outbound"))
            .await?
            .send()
            .await
            .map_err(transport_error)?;
        let response = checked(response).await?;
        let revision = revision(&response)?;
        let policy: OutboundNetworkConfig = legacy_reply(response).await?;
        policy.validate().map_err(uncertain)?;
        Ok(OutboundSnapshot { policy, revision })
    }

    pub(super) async fn read_outbound_status(&self, box_id: &str) -> BoxliteResult<OutboundStatus> {
        let response = self
            .outbound_request(
                Method::GET,
                &format!("/boxes/{box_id}/network/outbound/status"),
            )
            .await?
            .send()
            .await
            .map_err(transport_error)?;
        let status: OutboundStatus = legacy_reply(checked(response).await?).await?;
        status.persisted.policy.validate().map_err(uncertain)?;
        if let Some(observed) = &status.observed {
            observed.snapshot.policy.validate().map_err(uncertain)?;
        }
        if status.application_state == OutboundApplicationState::Confirmed
            && (status.pending_revision.is_some()
                || !status.observed.as_ref().is_some_and(|observed| {
                    observed.application_state == OutboundApplicationState::Confirmed
                        && observed.snapshot == status.persisted
                }))
        {
            return Err(uncertain(
                "confirmed status lacks matching durable and completed live state",
            ));
        }
        Ok(status)
    }

    pub(super) async fn replace_outbound_snapshot(
        &self,
        box_id: &str,
        replacement: &OutboundReplacement,
    ) -> BoxliteResult<OutboundReplaceOutcome> {
        let response = self
            .outbound_request(
                Method::PUT,
                &format!("/boxes/{box_id}/network/outbound/snapshot"),
            )
            .await?
            .header(header::IF_MATCH, format!("\"{}\"", replacement.expected()))
            .header(
                "X-Boxlite-Outbound-Revision",
                replacement.candidate().revision.as_str(),
            )
            .json(&replacement.candidate().policy)
            .send()
            .await
            .map_err(transport_error)?;
        if response.status() == StatusCode::PRECONDITION_FAILED {
            return Ok(OutboundReplaceOutcome::PreconditionFailed);
        }
        let response = checked(response).await?;
        if revision(&response)? != replacement.candidate().revision {
            return Err(uncertain(
                "acknowledgement revision does not match candidate",
            ));
        }
        let policy: OutboundNetworkConfig = legacy_reply(response).await?;
        if policy != replacement.candidate().policy {
            return Err(uncertain("acknowledgement policy does not match candidate"));
        }
        Ok(OutboundReplaceOutcome::Applied)
    }
}

#[cfg(test)]
#[path = "tests/outbound.rs"]
mod tests;
