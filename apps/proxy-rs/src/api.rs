// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! Client for the BoxLite control-plane API.
//!
//! Every method returns the decision the proxy needs — "is this box public",
//! "which runner holds it" — rather than a raw response, so status-code
//! interpretation lives in one place.

use std::time::Duration;

use http::StatusCode;
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde::{Deserialize, Serialize};

use crate::config::DiscoveredOidc;
use crate::error::{ProxyError, Result};
use crate::retry;

/// Nothing outside the unreserved set survives into a path segment; box IDs and
/// preview tokens are attacker-controlled and must not be able to add segments.
const PATH_SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'~');

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const ACTIVITY_UPDATE_TIMEOUT: Duration = Duration::from_secs(10);

/// Where a box's runner lives, and the key needed to talk to it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunnerInfo {
    #[serde(rename = "apiUrl")]
    pub api_url: String,
    #[serde(rename = "apiKey")]
    pub api_key: String,
}

pub struct ApiClient {
    http: reqwest::Client,
    base_url: String,
    api_key: String,
}

impl ApiClient {
    pub fn new(base_url: &str, api_key: &str) -> std::result::Result<Self, reqwest::Error> {
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(REQUEST_TIMEOUT)
                .build()?,
            base_url: base_url.trim_end_matches('/').to_string(),
            api_key: api_key.to_string(),
        })
    }

    /// OIDC settings the control plane publishes, used to fill gaps in the
    /// proxy's own environment.
    pub async fn get_oidc_config(&self) -> Result<DiscoveredOidc> {
        #[derive(Deserialize)]
        struct ConfigResponse {
            oidc: DiscoveredOidc,
        }

        let response = self.get("/config").send().await.map_err(transport_error)?;
        let response = check_status(response).await?;
        response
            .json::<ConfigResponse>()
            .await
            .map(|config| config.oidc)
            .map_err(|err| ProxyError::internal(format!("failed to decode API config: {err}")))
    }

    pub async fn get_runner_for_box(&self, box_id: &str) -> Result<RunnerInfo> {
        #[derive(Deserialize)]
        struct RunnerFull {
            #[serde(rename = "proxyUrl")]
            proxy_url: Option<String>,
            #[serde(rename = "apiKey")]
            api_key: String,
        }

        let path = format!("/runners/by-box/{}", escape(box_id));
        let runner: RunnerFull = retry::with_backoff(retry::REQUEST, "get runner by box", || {
            let path = path.clone();
            async move {
                let response = self.get(&path).send().await.map_err(transport_error)?;
                let response = check_status(response).await?;
                response
                    .json()
                    .await
                    .map_err(|err| ProxyError::internal(format!("failed to decode runner: {err}")))
            }
        })
        .await?;

        let api_url = runner
            .proxy_url
            .filter(|url| !url.is_empty())
            .ok_or_else(|| ProxyError::internal("runner proxy URL not found"))?;

        Ok(RunnerInfo {
            api_url,
            api_key: runner.api_key,
        })
    }

    pub async fn is_box_public(&self, box_id: &str) -> Result<bool> {
        let path = format!("/preview/{}/public", escape(box_id));
        retry::with_backoff(retry::REQUEST, "get box public", || {
            let path = path.clone();
            async move { self.probe(self.get(&path)).await }
        })
        .await
    }

    pub async fn is_valid_auth_token(&self, box_id: &str, auth_token: &str) -> Result<bool> {
        let path = format!(
            "/preview/{}/validate/{}",
            escape(box_id),
            escape(auth_token)
        );
        retry::with_backoff(retry::REQUEST, "validate preview token", || {
            let path = path.clone();
            async move { self.probe(self.get(&path)).await }
        })
        .await
    }

    /// Whether the user behind `user_token` may reach this box. Uses the user's
    /// own credentials, not the proxy's, so the API applies their permissions.
    pub async fn has_box_access(
        &self,
        box_id: &str,
        user_token: &str,
        client_ip: Option<&str>,
    ) -> Result<bool> {
        let path = format!("/preview/{}/access", escape(box_id));
        retry::with_backoff(retry::REQUEST, "check box access", || {
            let path = path.clone();
            async move {
                let mut request = self
                    .http
                    .get(format!("{}{path}", self.base_url))
                    .bearer_auth(user_token);
                if let Some(client_ip) = client_ip {
                    request = request.header("X-Forwarded-For", client_ip);
                }
                self.probe(request).await
            }
        })
        .await
    }

    /// Resolves a signed preview token to the box it grants access to. A token
    /// is scoped to one port, so the port is part of the question.
    pub async fn box_id_from_signed_token(&self, token: &str, port: &str) -> Result<String> {
        let path = format!("/preview/{}/{}/box-id", escape(token), escape(port));
        retry::with_backoff(retry::REQUEST, "resolve signed preview token", || {
            let path = path.clone();
            async move {
                let response = self.get(&path).send().await.map_err(transport_error)?;
                let response = check_status(response).await?;
                response
                    .text()
                    .await
                    .map_err(|err| ProxyError::internal(format!("failed to read box ID: {err}")))
            }
        })
        .await
    }

    /// Records that a box is still in use. Not retried: the caller polls, so a
    /// missed update is corrected within the poll interval.
    pub async fn update_last_activity(&self, box_id: &str) -> Result<()> {
        let response = self
            .http
            .post(format!(
                "{}/box/{}/last-activity",
                self.base_url,
                escape(box_id)
            ))
            .bearer_auth(&self.api_key)
            .timeout(ACTIVITY_UPDATE_TIMEOUT)
            .send()
            .await
            .map_err(transport_error)?;
        check_status(response).await.map(|_| ())
    }

    fn get(&self, path: &str) -> reqwest::RequestBuilder {
        self.http
            .get(format!("{}{path}", self.base_url))
            .bearer_auth(&self.api_key)
    }

    /// Runs a yes/no endpoint: 2xx means yes, a definitive client error means
    /// no, and anything else is a failure worth retrying. Timeouts and rate
    /// limits are deliberately *not* treated as "no" — answering "not public"
    /// because the API was busy would expose a private box's 404 as a 401.
    async fn probe(&self, request: reqwest::RequestBuilder) -> Result<bool> {
        let response = request.send().await.map_err(transport_error)?;
        let status = response.status();
        if status.is_success() {
            return Ok(true);
        }
        if status.is_client_error()
            && status != StatusCode::REQUEST_TIMEOUT
            && status != StatusCode::TOO_MANY_REQUESTS
        {
            return Ok(false);
        }
        Err(check_status(response)
            .await
            .expect_err("a non-success status always converts to an error"))
    }
}

fn escape(value: &str) -> String {
    utf8_percent_encode(value, PATH_SEGMENT).to_string()
}

/// Drops the URL before the error is rendered. Preview-token and auth-token
/// endpoints carry the credential in the path, and a transport error is
/// otherwise reported straight back to the client and into the log.
fn transport_error(err: reqwest::Error) -> ProxyError {
    ProxyError::internal(format!("BoxLite API request failed: {}", err.without_url()))
}

/// Turns a non-2xx response into a typed error, preferring the API's own error
/// envelope so its status and code reach the client unchanged.
async fn check_status(response: reqwest::Response) -> Result<reqwest::Response> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }

    #[derive(Deserialize)]
    struct ApiErrorBody {
        #[serde(rename = "statusCode")]
        status_code: Option<u16>,
        message: Option<String>,
        #[serde(default)]
        code: String,
    }

    let body = response.text().await.unwrap_or_default();
    let parsed = serde_json::from_str::<ApiErrorBody>(&body).ok();

    Err(match parsed {
        Some(parsed) => ProxyError::Upstream {
            status: parsed
                .status_code
                .and_then(|code| StatusCode::from_u16(code).ok())
                .unwrap_or(status),
            message: parsed.message.unwrap_or_else(|| status.to_string()),
            code: parsed.code,
        },
        None => ProxyError::Upstream {
            status,
            message: if body.is_empty() {
                status.to_string()
            } else {
                body
            },
            code: String::new(),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_segments_cannot_escape_their_position() {
        assert_eq!(escape("53MOZ3jp5Zu1"), "53MOZ3jp5Zu1");
        assert_eq!(escape("../../admin"), "..%2F..%2Fadmin");
        assert_eq!(escape("a b?c#d"), "a%20b%3Fc%23d");
    }
}
