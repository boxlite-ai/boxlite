use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use reqwest::{Method, Response, StatusCode, header};
use serde::Deserialize;
use serde_json::Value;

use crate::net::{
    CompleteOutboundPolicy, CompleteOutboundSnapshot, OutboundAdmission, OutboundApplicationState,
    OutboundPolicyEffect, OutboundPolicyError, OutboundPolicyObservation,
    OutboundPolicyReplacement, OutboundPolicyResult, OutboundPolicyStatus, OutboundRevision,
};
use crate::runtime::cpu_count::CpuCount;

use super::client::{ApiClient, transport_error};
use super::error::map_http_body;
use super::outbound::{body_error, checked, revision, uncertain};
use super::types::{BoxResponse, CreateBoxRequest};

#[derive(Deserialize)]
struct CloudStatus {
    persisted: Option<CompleteOutboundSnapshot>,
    runtime_persisted: Option<CompleteOutboundSnapshot>,
    observed: Option<OutboundPolicyObservation>,
    application_state: OutboundApplicationState,
    pending_revision: Option<OutboundRevision>,
}

pub(super) fn cloud_create_admission(policy: &CompleteOutboundPolicy) -> OutboundAdmission {
    if policy.deny_net.is_some() {
        OutboundAdmission::ExtendedIpv4
    } else {
        OutboundAdmission::Legacy
    }
}

fn resource(box_id: &str) -> BoxliteResult<String> {
    if !crate::BoxID::is_valid(box_id) {
        return Err(BoxliteError::InvalidArgument(
            "invalid Box ID for outbound policy".into(),
        ));
    }
    Ok(format!("/boxes/{box_id}/network/outbound/complete"))
}

async fn read_snapshot(response: Response) -> BoxliteResult<CompleteOutboundSnapshot> {
    let response = checked(response).await?;
    let etag = revision(&response)?;
    let snapshot: CompleteOutboundSnapshot = response.json().await.map_err(body_error)?;
    if snapshot.revision != etag {
        return Err(uncertain("ETag does not match the complete snapshot"));
    }
    snapshot.validate_installed().map_err(uncertain)?;
    Ok(snapshot)
}

fn string_field(body: &Value, name: &str) -> Option<String> {
    body.get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

async fn request_failure(response: Response, creating: bool) -> OutboundPolicyError {
    let status = response.status();
    let text = response.text().await;
    let body: Value = text
        .as_deref()
        .ok()
        .and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or_default();
    let envelope = body
        .get("error")
        .filter(|value| value.is_object())
        .unwrap_or(&body);
    let code = string_field(envelope, "code");
    let box_id = string_field(envelope, "box_id").or_else(|| string_field(envelope, "boxId"));
    let effect = if creating {
        match envelope.get("creation_effect").and_then(Value::as_str) {
            Some("not_allocated") if box_id.is_none() => OutboundPolicyEffect::NotAllocated,
            Some("allocated") => OutboundPolicyEffect::Allocated,
            _ => OutboundPolicyEffect::Uncertain,
        }
    } else if status == StatusCode::SERVICE_UNAVAILABLE
        && code.as_deref() == Some("outbound_pending")
    {
        OutboundPolicyEffect::Uncertain
    } else if status == StatusCode::PRECONDITION_FAILED
        || envelope.get("effect").and_then(Value::as_str) == Some("not_applied")
        || status == StatusCode::CONFLICT
            && matches!(
                code.as_deref(),
                Some("outbound_replace_busy" | "outbound_not_running")
            )
    {
        OutboundPolicyEffect::NotApplied
    } else {
        OutboundPolicyEffect::Uncertain
    };
    OutboundPolicyError::Request {
        effect,
        status: Some(status.as_u16()),
        code,
        box_id,
        message: match text {
            Ok(text) => map_http_body(status, &text).to_string(),
            Err(error) => body_error(error).to_string(),
        },
    }
}

pub(super) fn request_uncertain(
    status: Option<StatusCode>,
    box_id: Option<String>,
    error: BoxliteError,
) -> OutboundPolicyError {
    OutboundPolicyError::Request {
        effect: OutboundPolicyEffect::Uncertain,
        status: status.map(|status| status.as_u16()),
        code: None,
        box_id,
        message: error.to_string(),
    }
}

impl ApiClient {
    pub(super) async fn create_complete_outbound_box(
        &self,
        request: &CreateBoxRequest,
    ) -> OutboundPolicyResult<BoxResponse> {
        let requested = request.cpus.map(CpuCount::new).transpose()?;
        let response = self
            .complete_outbound_request(Method::POST, "/boxes")
            .await?
            .json(request)
            .send()
            .await
            .map_err(|error| request_uncertain(None, None, transport_error(error)))?;
        if response.status() != StatusCode::CREATED {
            return Err(request_failure(response, true).await);
        }
        let value: Value = response.json().await.map_err(|error| {
            request_uncertain(Some(StatusCode::CREATED), None, body_error(error))
        })?;
        let box_id = string_field(&value, "box_id");
        Self::decode_created_box(value, requested)
            .map_err(|error| request_uncertain(Some(StatusCode::CREATED), box_id, error))
    }

    pub(super) async fn read_complete_outbound_snapshot(
        &self,
        box_id: &str,
    ) -> BoxliteResult<CompleteOutboundSnapshot> {
        let response = self
            .complete_outbound_request(Method::GET, &resource(box_id)?)
            .await?
            .send()
            .await
            .map_err(transport_error)?;
        read_snapshot(response).await
    }

    pub(super) async fn read_outbound_policy_status(
        &self,
        box_id: &str,
    ) -> BoxliteResult<OutboundPolicyStatus> {
        let response = self
            .complete_outbound_request(Method::GET, &format!("{}/status", resource(box_id)?))
            .await?
            .send()
            .await
            .map_err(transport_error)?;
        let wire: CloudStatus = checked(response).await?.json().await.map_err(body_error)?;
        let status = OutboundPolicyStatus {
            persisted: wire.persisted,
            runtime_persisted: wire.runtime_persisted,
            observed: wire.observed,
            application_state: wire.application_state,
            pending_revision: wire.pending_revision,
            observation_error: None,
        };
        for snapshot in status
            .persisted
            .iter()
            .chain(&status.runtime_persisted)
            .chain(
                status
                    .observed
                    .iter()
                    .map(|observation| &observation.snapshot),
            )
        {
            snapshot.validate_installed().map_err(uncertain)?;
        }
        if status.application_state == OutboundApplicationState::Confirmed
            && (status.runtime_persisted.is_none() || status.confirmed_snapshot().is_none())
        {
            return Err(uncertain(
                "confirmed status lacks matching Cloud, Runner and live snapshots",
            ));
        }
        Ok(status)
    }

    pub(super) async fn replace_verified_outbound_policy(
        &self,
        box_id: &str,
        policy: CompleteOutboundPolicy,
        expected: Option<OutboundRevision>,
    ) -> OutboundPolicyResult<OutboundPolicyReplacement> {
        let previous = self.read_complete_outbound_snapshot(box_id).await?;
        if expected
            .as_ref()
            .is_some_and(|expected| expected != &previous.revision)
        {
            return Err(
                BoxliteError::InvalidState("outbound revision does not match".into()).into(),
            );
        }
        if !previous.policy.deny_net.is_empty() && policy.deny_net.is_none() {
            return Err(BoxliteError::InvalidArgument(
                "deny_net is required while outbound denies may be active".into(),
            )
            .into());
        }
        let candidate = previous.prepare_replacement(&policy, OutboundRevision::initial())?;
        let response = self
            .complete_outbound_request(Method::PUT, &resource(box_id)?)
            .await?
            .header(header::IF_MATCH, format!("\"{}\"", previous.revision))
            .json(&policy)
            .send()
            .await
            .map_err(|error| request_uncertain(None, None, transport_error(error)))?;
        let status = response.status();
        if status != StatusCode::OK {
            return Err(request_failure(response, false).await);
        }
        let acknowledged = read_snapshot(response)
            .await
            .map_err(|error| request_uncertain(Some(status), None, error))?;
        if acknowledged.revision == previous.revision
            || acknowledged.revision == OutboundRevision::initial()
            || acknowledged.admission != candidate.admission
            || acknowledged.ipv6 != candidate.ipv6
            || acknowledged.policy != candidate.policy
        {
            return Err(request_uncertain(
                Some(status),
                None,
                uncertain("replacement acknowledgement differs from the requested policy"),
            ));
        }
        Ok(OutboundPolicyReplacement::from_readback(
            acknowledged,
            self.read_outbound_policy_status(box_id).await,
        ))
    }
}
