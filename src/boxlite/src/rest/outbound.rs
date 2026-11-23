//! Revision-aware REST control; legacy policy setters keep their existing wire contract.
use super::client::{ApiClient, transport_error};
use super::error::map_http_body;
use super::managed_proxy::{ManagedErrorBody, public_json, read_error};
use crate::net::{
    OutboundApplicationState, OutboundReplaceOutcome, OutboundReplacement, OutboundRevision,
    OutboundSnapshot, OutboundStatus,
};
use crate::runtime::options::OutboundNetworkConfig;
use crate::{
    ManagedProxyStatus, ProxyIdentity, ProxyMutation, ProxyMutationState, ProxyPolicyRevision,
    ProxyRuntimeReadback,
};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use reqwest::{Method, Response, StatusCode, header};
use serde::Deserialize;

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

async fn decode_outbound_policy(response: Response) -> BoxliteResult<OutboundNetworkConfig> {
    let mut fields: serde_json::Map<String, serde_json::Value> =
        response.json().await.map_err(body_error)?;
    if let Some(proxy) = fields.remove("proxy")
        && !matches!(
            proxy,
            serde_json::Value::String(_) | serde_json::Value::Null
        )
    {
        return Err(uncertain("proxy must be a registration name or null"));
    }
    let policy: OutboundNetworkConfig =
        serde_json::from_value(serde_json::Value::Object(fields))
            .map_err(|_| uncertain("unsupported outbound policy fields or values"))?;
    policy
        .validate()
        .map_err(|_| uncertain("invalid outbound policy"))?;
    Ok(policy)
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
        let policy = decode_outbound_policy(response).await?;
        Ok(OutboundSnapshot { policy, revision })
    }

    pub(super) async fn read_managed_proxy_status(
        &self,
        box_id: &str,
    ) -> BoxliteResult<ManagedProxyStatus> {
        #[derive(Default, Deserialize)]
        struct Readback {
            desired: Option<ProxyIdentity>,
            committed: Option<ProxyIdentity>,
            pending: Option<ProxyPolicyRevision>,
            installed: Option<ProxyPolicyRevision>,
            runtime_readback: ProxyRuntimeReadback,
        }
        #[derive(Deserialize)]
        struct WireStatus {
            persisted: OutboundSnapshot,
            application_state: OutboundApplicationState,
            #[serde(default)]
            proxy: Readback,
        }
        let response = self
            .managed_request(
                Method::GET,
                &format!("/boxes/{box_id}/network/outbound/status"),
            )
            .await?
            .send()
            .await
            .map_err(transport_error)?;
        let status: WireStatus = public_json(response).await?;
        Ok(ManagedProxyStatus {
            revision: status.persisted.revision,
            application_state: status.application_state,
            desired: status.proxy.desired,
            committed: status.proxy.committed,
            pending: status.proxy.pending,
            installed: status.proxy.installed,
            runtime_readback: status.proxy.runtime_readback,
        })
    }

    pub(super) async fn replace_managed_binding(
        &self,
        box_id: &str,
        proxy: Option<&str>,
    ) -> BoxliteResult<ProxyMutation> {
        #[derive(serde::Serialize)]
        struct Replace<'a> {
            #[serde(flatten)]
            policy: OutboundNetworkConfig,
            proxy: Option<&'a str>,
        }
        self.require_managed_proxy().await?;
        let path = format!("/boxes/{box_id}/network/outbound");
        let response = self
            .managed_request(Method::GET, &path)
            .await?
            .send()
            .await
            .map_err(transport_error)?;
        if response.status() != StatusCode::OK {
            return Err(read_error(response.status()));
        }
        let expected = revision(&response)?;
        let policy = decode_outbound_policy(response).await?;
        let request = self
            .managed_request(Method::PUT, &path)
            .await?
            .header(header::IF_MATCH, format!("\"{expected}\""))
            .json(&Replace { policy, proxy });
        let Ok(response) = request.send().await else {
            return Ok(ProxyMutation::new(ProxyMutationState::Unknown, None));
        };
        let status = response.status();
        if status != StatusCode::OK {
            let state = match status.as_u16() {
                400 | 401 | 403 | 404 | 412 | 429 => ProxyMutationState::Rejected,
                409 if response
                    .json::<ManagedErrorBody>()
                    .await
                    .ok()
                    .and_then(|body| body.code)
                    .as_deref()
                    == Some("outbound_update_blocked") =>
                {
                    ProxyMutationState::Rejected
                }
                _ => ProxyMutationState::Unknown,
            };
            return Ok(ProxyMutation::new(state, Some(status.as_u16())));
        }
        let mut result = ProxyMutation::new(ProxyMutationState::Accepted, Some(status.as_u16()));
        result.revision = revision(&response).ok();
        if proxy.is_none() {
            let confirmed = if let Some(revision) = &result.revision {
                self.read_managed_proxy_status(box_id)
                    .await
                    .is_ok_and(|readback| {
                        readback.revision == *revision
                            && readback.application_state == OutboundApplicationState::Confirmed
                            && readback.runtime_readback == ProxyRuntimeReadback::Authenticated
                            && readback.installed.is_some_and(|installed| {
                                installed.proxy.is_none() && installed.policy_revision == *revision
                            })
                    })
            } else {
                false
            };
            if !confirmed {
                result.state = ProxyMutationState::AcceptedReleaseUnconfirmed;
            }
        }
        Ok(result)
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
        let status: OutboundStatus = checked(response).await?.json().await.map_err(body_error)?;
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
        let policy: OutboundNetworkConfig = response.json().await.map_err(body_error)?;
        if policy != replacement.candidate().policy {
            return Err(uncertain("acknowledgement policy does not match candidate"));
        }
        Ok(OutboundReplaceOutcome::Applied)
    }
}

#[cfg(test)]
#[path = "tests/outbound.rs"]
mod tests;
