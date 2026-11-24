//! Guarded Cloud operations and their public wire responses.

use reqwest::{Method, Response, StatusCode};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use super::{
    client::ApiClient,
    types::{BoxResponse, CreateBoxRequest},
};
use crate::runtime::outbound_proxy::{OutboundProxyBackend, proxy_name};
use crate::{
    BoxID, BoxliteError, BoxliteResult, ManagedCreateAdmission, ManagedCreateError, OutboundProxy,
    ProxyCredential, ProxyCredentialChange, ProxyMutation, ProxyMutationState,
};

pub(super) fn read_error(status: StatusCode) -> BoxliteError {
    match status {
        StatusCode::NOT_FOUND => BoxliteError::NotFound("outbound proxy or Box not found".into()),
        StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => BoxliteError::Config(format!(
            "Cloud outbound proxy access denied (HTTP {})",
            status.as_u16()
        )),
        _ => BoxliteError::Network(format!(
            "Cloud outbound proxy request failed (HTTP {})",
            status.as_u16()
        )),
    }
}

pub(super) async fn public_json<T: DeserializeOwned>(response: Response) -> BoxliteResult<T> {
    if !response.status().is_success() {
        return Err(read_error(response.status()));
    }
    response
        .json()
        .await
        .map_err(|_| BoxliteError::Network("invalid Cloud outbound proxy response".into()))
}

fn validate_endpoint(value: &str) -> BoxliteResult<()> {
    let valid = value.contains("://")
        && value.len() <= 2048
        && !value.contains(['\\', '@', '?', '#', '%'])
        && !value.bytes().any(|byte| byte <= b' ' || byte == 0x7f)
        && reqwest::Url::parse(value).is_ok_and(|url| {
            matches!(url.scheme(), "http" | "https" | "socks5")
                && url.host_str().is_some_and(|host| !host.is_empty())
                && url.port() != Some(0)
                && matches!(url.path(), "" | "/")
        });
    if !valid {
        return Err(BoxliteError::InvalidArgument(
            "invalid proxy endpoint URL".into(),
        ));
    }
    Ok(())
}

fn public_registration(proxy: OutboundProxy) -> BoxliteResult<OutboundProxy> {
    if proxy_name(&proxy.name).is_err()
        || validate_endpoint(&proxy.url).is_err()
        || proxy.revision == 0
    {
        return Err(BoxliteError::Network(
            "invalid public proxy registration".into(),
        ));
    }
    Ok(proxy)
}

fn registry_outcome(response: Result<Response, reqwest::Error>) -> ProxyMutation {
    let Ok(response) = response else {
        return ProxyMutation::new(ProxyMutationState::Unknown, None);
    };
    let status = response.status();
    let state = if status.is_success() {
        ProxyMutationState::Accepted
    } else if matches!(
        status.as_u16(),
        400 | 401 | 403 | 404 | 409 | 413 | 415 | 429
    ) {
        ProxyMutationState::Rejected
    } else {
        ProxyMutationState::Unknown
    };
    ProxyMutation::new(state, Some(status.as_u16()))
}

#[async_trait::async_trait]
impl OutboundProxyBackend for ApiClient {
    async fn list(&self) -> BoxliteResult<Vec<OutboundProxy>> {
        #[derive(Deserialize)]
        struct Registry {
            proxies: Vec<OutboundProxy>,
        }
        self.require_registry_https()?;
        self.require_managed_proxy().await?;
        let response = self
            .managed_request(Method::GET, "/proxies")
            .await?
            .send()
            .await
            .map_err(|_| BoxliteError::Network("proxy registry read failed".into()))?;
        let registry: Registry = public_json(response).await?;
        registry
            .proxies
            .into_iter()
            .map(public_registration)
            .collect()
    }

    async fn get(&self, name: &str) -> BoxliteResult<OutboundProxy> {
        self.require_registry_https()?;
        self.require_managed_proxy().await?;
        let response = self
            .managed_request(Method::GET, &format!("/proxies/{name}"))
            .await?
            .send()
            .await
            .map_err(|_| BoxliteError::Network("proxy registry read failed".into()))?;
        public_registration(public_json(response).await?)
    }

    async fn create(
        &self,
        name: &str,
        url: &str,
        credential: Option<&ProxyCredential>,
    ) -> BoxliteResult<ProxyMutation> {
        #[derive(Serialize)]
        struct Registration<'a> {
            name: &'a str,
            url: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            credential: Option<&'a ProxyCredential>,
        }
        self.require_registry_https()?;
        validate_endpoint(url)?;
        self.require_managed_proxy().await?;
        let request = self
            .managed_request(Method::POST, "/proxies")
            .await?
            .json(&Registration {
                name,
                url,
                credential,
            });
        Ok(registry_outcome(request.send().await))
    }

    async fn update(
        &self,
        name: &str,
        url: Option<&str>,
        credential: ProxyCredentialChange,
    ) -> BoxliteResult<ProxyMutation> {
        #[derive(Serialize)]
        struct Patch<'a> {
            #[serde(skip_serializing_if = "Option::is_none")]
            url: Option<&'a str>,
            #[serde(skip_serializing_if = "Option::is_none")]
            credential: Option<Option<ProxyCredential>>,
        }
        self.require_registry_https()?;
        if let Some(url) = url {
            validate_endpoint(url)?;
        }
        let credential = match credential {
            ProxyCredentialChange::Keep => None,
            ProxyCredentialChange::Clear => Some(None),
            ProxyCredentialChange::Set(credential) => Some(Some(credential)),
        };
        self.require_managed_proxy().await?;
        let request = self
            .managed_request(Method::PATCH, &format!("/proxies/{name}"))
            .await?
            .json(&Patch { url, credential });
        Ok(registry_outcome(request.send().await))
    }

    async fn remove(&self, name: &str) -> BoxliteResult<ProxyMutation> {
        self.require_registry_https()?;
        self.require_managed_proxy().await?;
        let request = self
            .managed_request(Method::DELETE, &format!("/proxies/{name}"))
            .await?;
        Ok(registry_outcome(request.send().await))
    }
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub(super) struct ManagedErrorBody {
    pub code: Option<String>,
}

impl ApiClient {
    pub(super) async fn create_managed_box(
        &self,
        request: &CreateBoxRequest,
    ) -> Result<crate::BoxInfo, ManagedCreateError> {
        let request = self
            .managed_request(Method::POST, "/boxes")
            .await?
            .json(request);
        let response = request.send().await.map_err(|_| ManagedCreateError {
            admission: ManagedCreateAdmission::Unknown,
            http_status: None,
            box_id: None,
            source: BoxliteError::Network("Cloud create acknowledgement unavailable".into()),
        })?;
        let status = response.status();
        let body = response.bytes().await.ok();
        if status.is_success()
            && let Some(info) = body
                .as_deref()
                .and_then(|bytes| serde_json::from_slice::<BoxResponse>(bytes).ok())
                .and_then(|response| response.to_box_info().ok())
        {
            return Ok(info);
        }

        // Recover the identity independently of the rest of the acknowledgement.
        let evidence: serde_json::Value = body
            .as_deref()
            .and_then(|bytes| serde_json::from_slice(bytes).ok())
            .unwrap_or_default();
        let (admission, source, id_fields) = if status.is_success() {
            (
                ManagedCreateAdmission::Unknown,
                BoxliteError::Network("invalid Cloud create acknowledgement".into()),
                ["box_id", "boxId"],
            )
        } else {
            let admission = match evidence.get("code").and_then(serde_json::Value::as_str) {
                Some("outbound_create_rejected") => ManagedCreateAdmission::Rejected,
                Some("outbound_create_admitted") => ManagedCreateAdmission::Admitted,
                _ => ManagedCreateAdmission::Unknown,
            };
            (admission, read_error(status), ["boxId", "box_id"])
        };
        let box_id = id_fields
            .into_iter()
            .filter_map(|field| evidence.get(field).and_then(serde_json::Value::as_str))
            .find_map(BoxID::parse);
        Err(ManagedCreateError {
            admission,
            http_status: Some(status.as_u16()),
            box_id,
            source,
        })
    }
}
