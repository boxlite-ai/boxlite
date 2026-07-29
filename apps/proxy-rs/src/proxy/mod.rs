// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! The preview proxy.
//!
//! Requests arrive on `<port>-<boxId | signedToken>.<domain>`. The hostname says
//! which box and which port; everything else — is it public, who is allowed in,
//! which machine holds it — is answered by the control plane and cached here.

pub mod activity;
pub mod auth;
pub mod forward;
pub mod host;
pub mod login;
pub mod oidc;
pub mod runners;
pub mod tunnel;
pub mod upstream;
pub mod warning;

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use http::header::{HeaderName, HeaderValue};
use http::{HeaderMap, Method, Request, Response, StatusCode};

use crate::api::ApiClient;
use crate::body::{self, Body};
use crate::cache::{Cache, RedisPool};
use crate::config::{Config, VERSION};
use crate::cors;
use crate::error::{ProxyError, Result};
use crate::response;
use crate::signed_cookie::CookieSigner;

use activity::ActivityReporter;
use auth::Authentication;
use forward::RequestTarget;
use host::PreviewHost;
use runners::RunnerDirectory;
use upstream::{Clients, Upstream};

/// The box terminal is served by the runner's API rather than a port inside the
/// box, and always requires authentication even on a public box.
pub const TERMINAL_PORT: &str = "22222";

const PKCE_COOKIE_NAME: &str = "pkce_verifier";
const PKCE_COOKIE_MAX_AGE: Duration = Duration::from_secs(300);
const OIDC_STATE_NAME: &str = "oidc_state";

/// Visibility flips when a user toggles it, and the answer gates authentication,
/// so it is cached only long enough to absorb a page's worth of parallel loads.
const BOX_PUBLIC_TTL: Duration = Duration::from_secs(3);

pub type StartupError = Box<dyn std::error::Error + Send + Sync>;

pub struct Proxy {
    config: Config,
    api: Arc<ApiClient>,
    runners: Arc<RunnerDirectory>,
    clients: Clients,
    oidc: oidc::OidcProvider,
    activity: Arc<ActivityReporter>,
    signer: CookieSigner,
    /// Set when one domain is pinned for all cookies; otherwise derived per
    /// request from the host.
    cookie_domain: Option<String>,
    box_public: Cache<bool>,
    auth_valid: Cache<bool>,
}

impl Proxy {
    pub async fn new(config: Config) -> std::result::Result<Arc<Self>, StartupError> {
        let api = Arc::new(ApiClient::new(
            &config.boxlite_api_url,
            &config.proxy_api_key,
        )?);

        let pool = match &config.redis {
            Some(redis) => Some(RedisPool::connect(redis).await?),
            None => None,
        };

        let runners = Arc::new(RunnerDirectory::new(
            api.clone(),
            build_cache(pool.as_ref(), "proxy:box-runner-info:"),
        ));

        Ok(Arc::new(Self {
            signer: CookieSigner::new(&config.proxy_api_key),
            cookie_domain: config.cookie_domain.as_deref().map(cookie_domain_for),
            oidc: oidc::OidcProvider::new(config.oidc.clone())?,
            activity: Arc::new(ActivityReporter::new(
                api.clone(),
                build_cache(pool.as_ref(), "proxy:box-last-activity-update:"),
            )),
            box_public: build_cache(pool.as_ref(), "proxy:box-public:"),
            auth_valid: build_cache(pool.as_ref(), "proxy:box-auth-key-valid:"),
            clients: Clients::new(runners.clone()),
            runners,
            api,
            config,
        }))
    }

    pub fn config(&self) -> &Config {
        &self.config
    }

    /// Entry point for every non-CONNECT request. Always answers: a failure
    /// becomes an error response rather than a dropped connection.
    pub async fn handle<B>(
        self: &Arc<Self>,
        mut request: Request<B>,
        remote_addr: SocketAddr,
    ) -> Response<Body>
    where
        B: hyper::body::Body<Data = bytes::Bytes> + Send + Sync + 'static,
        B::Error: Into<crate::body::BoxError>,
    {
        let request_host = request_host(&request);
        // Evaluated once, before the opt-out header is dropped, so the decision
        // and the headers it produces cannot disagree.
        let cors = cors::evaluate(&request, &request_host);
        request.headers_mut().remove(cors::DISABLE_HEADER);

        // A preflight is answered here; forwarding it would make every box
        // responsible for its own CORS.
        let cors_headers = match cors {
            Some(cors) if cors.is_preflight => {
                let mut response = Response::new(body::empty());
                *response.status_mut() = StatusCode::NO_CONTENT;
                response::merge_headers(&mut response, cors.headers);
                return response;
            }
            Some(cors) => Some(cors.headers),
            None => None,
        };

        let method = request.method().clone();
        let path = request.uri().path().to_string();

        let mut response = match self.route(request, &request_host, remote_addr).await {
            Ok(response) => response,
            Err(err) => err.into_response(&path, &method),
        };
        if let Some(cors_headers) = cors_headers {
            response::merge_headers(&mut response, cors_headers);
        }
        response
    }

    async fn route<B>(
        self: &Arc<Self>,
        request: Request<B>,
        request_host: &str,
        remote_addr: SocketAddr,
    ) -> Result<Response<Body>>
    where
        B: hyper::body::Body<Data = bytes::Bytes> + Send + Sync + 'static,
        B::Error: Into<crate::body::BoxError>,
    {
        let preview = host::parse_host(request_host).ok();
        let https = self.config.serves_https();

        if self.config.preview_warning_enabled
            && warning::should_warn(
                request.headers(),
                request.method(),
                request.uri(),
                preview.as_ref(),
            )
        {
            return Ok(warning::page(&request, request_host, https));
        }

        if request.method() == Method::POST && request.uri().path() == warning::ACCEPT_PATH {
            return Ok(warning::accept(&request, request_host, https));
        }

        let Some(preview) = preview else {
            // Not a preview hostname, so this is one of the proxy's own routes.
            return match (request.method(), request.uri().path()) {
                (&Method::GET, "/callback") => {
                    self.auth_callback(&request, request_host, remote_addr)
                        .await
                }
                (&Method::GET, "/health") => Ok(response::json(
                    StatusCode::OK,
                    &serde_json::json!({ "status": "ok", "version": VERSION }),
                )),
                _ => Err(ProxyError::not_found("not found")),
            };
        };

        self.proxy_to_box(request, preview, request_host, remote_addr)
            .await
    }

    async fn proxy_to_box<B>(
        self: &Arc<Self>,
        mut request: Request<B>,
        preview: PreviewHost,
        request_host: &str,
        remote_addr: SocketAddr,
    ) -> Result<Response<Body>>
    where
        B: hyper::body::Body<Data = bytes::Bytes> + Send + Sync + 'static,
        B::Error: Into<crate::body::BoxError>,
    {
        if preview.box_id_or_token.is_empty() {
            return Err(ProxyError::bad_request(
                "box ID or signed token is required",
            ));
        }

        let box_reference = match host::decode_direct_box_id(&preview.box_id_or_token)? {
            Some(decoded) => decoded,
            None => preview.box_id_or_token.clone(),
        };
        let is_public = self.box_is_public(&box_reference).await?;

        let mut box_id = box_reference.clone();
        let mut cookies = HeaderMap::new();
        if !is_public || preview.target_port == TERMINAL_PORT {
            match self
                .authenticate(
                    &mut request,
                    &box_reference,
                    &preview.target_port,
                    request_host,
                )
                .await?
            {
                Authentication::Allowed {
                    box_id: authenticated,
                    cookies: issued,
                } => {
                    box_id = authenticated;
                    cookies = issued;
                }
                Authentication::Login(redirect) => return Ok(redirect),
            }
        }

        // Started before forwarding so a request that never returns (a terminal,
        // a stream) still keeps the box alive.
        let activity = self.activity.start(box_id.clone());

        let target = self
            .build_target(&request, &preview, &box_id, request_host)
            .await?;
        let client_ip = client_ip(request.headers(), remote_addr);
        let mut response = forward::forward(
            request,
            target,
            &self.clients,
            client_ip.as_deref(),
            activity,
        )
        .await?;
        response::merge_headers(&mut response, cookies);

        Ok(response)
    }

    /// Resolves where a request actually goes: straight to a port inside the box
    /// over a runner tunnel, or to the runner's API for the terminal.
    async fn build_target<B>(
        &self,
        request: &Request<B>,
        preview: &PreviewHost,
        box_id: &str,
        request_host: &str,
    ) -> Result<RequestTarget> {
        let path = host::escaped_path(request.uri());
        let proto = self.config.proxy_protocol.clone();
        let mut headers = vec![
            (
                HeaderName::from_static("x-forwarded-host"),
                header_value(request_host)?,
            ),
            (
                HeaderName::from_static("x-forwarded-proto"),
                header_value(&proto)?,
            ),
            (
                HeaderName::from_static("x-forwarded-port"),
                header_value(&host::forwarded_port_from_host(request_host, &proto))?,
            ),
        ];

        if preview.target_port != TERMINAL_PORT {
            let port: u16 = preview
                .target_port
                .parse()
                .map_err(|err| ProxyError::bad_request(format!("invalid target port: {err}")))?;
            // The authority is the box ID, which the guest connector resolves to
            // a runner tunnel; the box still sees the preview hostname.
            let uri = format!("http://{box_id}:{port}{path}")
                .parse()
                .map_err(|err| {
                    ProxyError::internal(format!("failed to parse guest target URL: {err}"))
                })?;

            return Ok(RequestTarget {
                uri,
                host: request_host.to_string(),
                headers,
                upstream: Upstream::Guest,
            });
        }

        let runner =
            self.runners.for_box(box_id).await.map_err(|err| {
                ProxyError::bad_request(format!("failed to get runner info: {err}"))
            })?;
        let uri: http::Uri = format!(
            "{}/boxes/{box_id}/toolbox/proxy/{}{path}",
            runner.api_url.trim_end_matches('/'),
            preview.target_port,
        )
        .parse()
        .map_err(|err| {
            ProxyError::internal(format!("failed to parse terminal target URL: {err}"))
        })?;

        headers.push((
            HeaderName::from_static("x-boxlite-authorization"),
            header_value(&format!("Bearer {}", runner.api_key))?,
        ));

        Ok(RequestTarget {
            host: uri
                .authority()
                .map(|authority| authority.to_string())
                .unwrap_or_default(),
            uri,
            headers,
            upstream: Upstream::Runner,
        })
    }

    async fn box_is_public(&self, box_id: &str) -> Result<bool> {
        if let Some(cached) = self.box_public.get(box_id).await {
            return Ok(cached);
        }

        let is_public = self.api.is_box_public(box_id).await.map_err(|err| {
            ProxyError::bad_request(format!("failed to get box public status: {err}"))
        })?;
        self.box_public.set(box_id, is_public, BOX_PUBLIC_TTL).await;
        Ok(is_public)
    }

    fn cookie_domain(&self, request_host: &str) -> String {
        self.cookie_domain
            .clone()
            .unwrap_or_else(|| cookie_domain_for(request_host))
    }
}

/// Redis when it is configured, in-process otherwise — chosen per cache so all
/// of them agree about which backend is in use.
fn build_cache<T>(pool: Option<&RedisPool>, key_prefix: &str) -> Cache<T>
where
    T: Clone + Send + Sync + serde::Serialize + serde::de::DeserializeOwned + 'static,
{
    match pool {
        Some(pool) => Cache::redis(pool, key_prefix),
        None => Cache::in_memory(),
    }
}

/// Cookies are shared across every `<port>-<box>` subdomain of the proxy domain,
/// so one login covers every port of a box.
fn cookie_domain_for(host: &str) -> String {
    format!(".{}", host.split(':').next().unwrap_or(host))
}

/// The hostname the client asked for: the `Host` header, or the authority when
/// the request line carried one.
pub fn request_host<B>(request: &Request<B>) -> String {
    request
        .uri()
        .authority()
        .map(|authority| authority.to_string())
        .or_else(|| {
            request
                .headers()
                .get(http::header::HOST)
                .and_then(|value| value.to_str().ok())
                .map(str::to_string)
        })
        .unwrap_or_default()
}

/// The address the request came from, preferring what the load balancer reports.
fn client_ip(headers: &HeaderMap, remote_addr: SocketAddr) -> Option<String> {
    headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .map(|first| first.trim().to_string())
        .filter(|first| !first.is_empty())
        .or_else(|| Some(remote_addr.ip().to_string()))
}

fn header_value(value: &str) -> Result<HeaderValue> {
    HeaderValue::from_str(value)
        .map_err(|err| ProxyError::bad_request(format!("invalid forwarded header value: {err}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cookie_domain_drops_the_port_and_widens_to_the_parent() {
        assert_eq!(
            cookie_domain_for("3000-box.proxy.test:8443"),
            ".3000-box.proxy.test"
        );
        assert_eq!(cookie_domain_for("proxy.test"), ".proxy.test");
    }

    #[test]
    fn client_ip_prefers_the_load_balancer_report() {
        let mut headers = HeaderMap::new();
        let socket: SocketAddr = "10.0.0.1:5000".parse().unwrap();
        assert_eq!(client_ip(&headers, socket).as_deref(), Some("10.0.0.1"));

        headers.insert("x-forwarded-for", "203.0.113.7, 10.0.0.1".parse().unwrap());
        assert_eq!(client_ip(&headers, socket).as_deref(), Some("203.0.113.7"));
    }
}
