// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! Deciding whether a caller may reach a private box.
//!
//! Five credentials are accepted, tried in order of how cheap and how specific
//! they are: an API bearer token, a preview token in a header, the same token in
//! a query parameter, a signed cookie from an earlier visit, and finally the
//! hostname itself being a signed preview token. A browser with none of them is
//! sent to log in.

use std::time::Duration;

use http::{HeaderMap, Request};

use crate::error::{ProxyError, Result};
use crate::response::{self, CookieOptions};

use super::Proxy;
use super::host::query_param;

pub const PREVIEW_TOKEN_HEADER: &str = "X-BoxLite-Preview-Token";
pub const PREVIEW_TOKEN_QUERY_PARAM: &str = "BOXLITE_BOX_AUTH_KEY";
pub const BOX_AUTH_COOKIE_PREFIX: &str = "boxlite-box-auth-";

const BOX_AUTH_COOKIE_MAX_AGE: Duration = Duration::from_secs(3600);

/// Long enough to keep the API off the hot path, short enough that revoking a
/// token takes effect while a session is still live.
const VALIDATION_TTL: Duration = Duration::from_secs(120);

pub enum Authentication {
    /// The caller may proceed to this box. `cookies` carries anything that
    /// should be set on the eventual response.
    Allowed { box_id: String, cookies: HeaderMap },
    /// The caller is a browser with no credentials: send it to log in.
    Login(http::Response<crate::body::Body>),
}

impl Proxy {
    /// `box_id_or_token` is whatever the hostname carried — a box ID for a
    /// direct preview URL, or a signed token that resolves to one.
    pub(super) async fn authenticate<B>(
        &self,
        request: &mut Request<B>,
        box_id_or_token: &str,
        target_port: &str,
        request_host: &str,
    ) -> Result<Authentication> {
        // Fixed labels, never interpolated values: on a signed-token preview URL
        // the box reference *is* the credential, and an upstream error can quote
        // a URL that contains one.
        let mut rejections: Vec<&'static str> = Vec::new();

        if let Some(bearer) = bearer_token(request.headers()) {
            match self.bearer_grants_access(box_id_or_token, &bearer).await {
                Ok(true) => return Ok(allowed(box_id_or_token)),
                Ok(false) => rejections.push("bearer-token-invalid"),
                Err(err) => {
                    tracing::warn!(error = %err, "bearer token validation failed");
                    rejections.push("bearer-token-error");
                }
            }
        }

        // Removed either way: a preview token is for us, and forwarding it into
        // the box would leak a credential to whatever is running there.
        if let Some(token) = take_header(request.headers_mut(), PREVIEW_TOKEN_HEADER) {
            match self.preview_token_is_valid(box_id_or_token, &token).await {
                Ok(true) => return Ok(allowed(box_id_or_token)),
                Ok(false) => rejections.push("preview-token-header-invalid"),
                Err(err) => {
                    tracing::warn!(error = %err, "preview token header validation failed");
                    rejections.push("preview-token-header-error");
                }
            }
        }

        if let Some(token) = query_param(request.uri(), PREVIEW_TOKEN_QUERY_PARAM) {
            match self.preview_token_is_valid(box_id_or_token, &token).await {
                Ok(true) => {
                    strip_query_param(request, PREVIEW_TOKEN_QUERY_PARAM)?;
                    return Ok(allowed(box_id_or_token));
                }
                Ok(false) => rejections.push("preview-token-query-invalid"),
                Err(err) => {
                    tracing::warn!(error = %err, "preview token query validation failed");
                    rejections.push("preview-token-query-error");
                }
            }
        }

        let cookie_name = format!("{BOX_AUTH_COOKIE_PREFIX}{box_id_or_token}");
        if let Some(cookie) = response::read_cookie(request.headers(), &cookie_name) {
            match self
                .signer
                .decode(&cookie_name, &cookie, BOX_AUTH_COOKIE_MAX_AGE)
            {
                Ok(box_id) => return Ok(allowed(&box_id)),
                Err(err) => {
                    tracing::debug!(error = %err, "box auth cookie rejected");
                    rejections.push("cookie-rejected");
                }
            }
        }

        match self
            .api
            .box_id_from_signed_token(box_id_or_token, target_port)
            .await
        {
            Ok(box_id) => {
                // Remembered so the token only has to be resolved once per hour
                // rather than on every asset the page loads.
                let mut cookies = HeaderMap::new();
                self.issue_box_auth_cookie(&mut cookies, &cookie_name, &box_id, request_host);
                return Ok(Authentication::Allowed { box_id, cookies });
            }
            Err(err) => {
                tracing::debug!(error = %err, "hostname is not a valid signed preview token");
                rejections.push("signed-token-unresolved");
            }
        }

        tracing::info!(
            rejected = rejections.join(","),
            "no accepted credential, redirecting to login"
        );
        Ok(Authentication::Login(
            self.login_redirect(request, box_id_or_token, request_host)
                .await?,
        ))
    }

    async fn bearer_grants_access(&self, box_id: &str, bearer: &str) -> Result<bool> {
        self.cached_validation(box_id, bearer, || {
            self.api.has_box_access(box_id, bearer, None)
        })
        .await
    }

    async fn preview_token_is_valid(&self, box_id: &str, token: &str) -> Result<bool> {
        self.cached_validation(box_id, token, || {
            self.api.is_valid_auth_token(box_id, token)
        })
        .await
    }

    /// Both credential kinds share one cache keyed by box and secret, so a
    /// repeated request never re-hits the API regardless of which it presented.
    async fn cached_validation<F, Fut>(
        &self,
        box_id: &str,
        secret: &str,
        validate: F,
    ) -> Result<bool>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<bool>>,
    {
        let key = format!("{box_id}:{secret}");
        if let Some(cached) = self.auth_valid.get(&key).await {
            return Ok(cached);
        }

        let is_valid = validate().await?;
        self.auth_valid.set(&key, is_valid, VALIDATION_TTL).await;
        Ok(is_valid)
    }

    pub(super) fn issue_box_auth_cookie(
        &self,
        cookies: &mut HeaderMap,
        cookie_name: &str,
        box_id: &str,
        request_host: &str,
    ) {
        let mut carrier = http::Response::new(crate::body::empty());
        response::set_cookie(
            &mut carrier,
            cookie_name,
            &self.signer.encode(cookie_name, box_id),
            CookieOptions {
                domain: &self.cookie_domain(request_host),
                max_age: Some(BOX_AUTH_COOKIE_MAX_AGE),
                secure: self.config.serves_https(),
                http_only: true,
                same_site: None,
            },
        );

        for value in carrier.headers().get_all(http::header::SET_COOKIE) {
            cookies.append(http::header::SET_COOKIE, value.clone());
        }
    }
}

fn allowed(box_id: &str) -> Authentication {
    Authentication::Allowed {
        box_id: box_id.to_string(),
        cookies: HeaderMap::new(),
    }
}

fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(http::header::AUTHORIZATION)?.to_str().ok()?;
    let token = value.strip_prefix("Bearer ")?.trim();
    (!token.is_empty()).then(|| token.to_string())
}

fn take_header(headers: &mut HeaderMap, name: &str) -> Option<String> {
    let value = headers
        .remove(name)?
        .to_str()
        .ok()
        .map(str::to_string)
        .unwrap_or_default();
    (!value.is_empty()).then_some(value)
}

/// Drops a consumed credential from the URL so it is never forwarded into the
/// box, logged there, or leaked through a `Referer`.
fn strip_query_param<B>(request: &mut Request<B>, name: &str) -> Result<()> {
    let uri = request.uri();
    let remaining: Vec<&str> = uri
        .query()
        .unwrap_or_default()
        .split('&')
        .filter(|pair| pair.split_once('=').map(|(key, _)| key) != Some(name))
        .filter(|pair| !pair.is_empty())
        .collect();

    let mut parts = uri.clone().into_parts();
    let path = uri.path();
    let rebuilt = if remaining.is_empty() {
        path.to_string()
    } else {
        format!("{path}?{}", remaining.join("&"))
    };
    parts.path_and_query =
        Some(rebuilt.parse().map_err(|err| {
            ProxyError::internal(format!("failed to rewrite request URL: {err}"))
        })?);
    *request.uri_mut() = http::Uri::from_parts(parts)
        .map_err(|err| ProxyError::internal(format!("failed to rewrite request URL: {err}")))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_bearer_token() {
        let mut headers = HeaderMap::new();
        headers.insert(
            http::header::AUTHORIZATION,
            "Bearer  abc123 ".parse().unwrap(),
        );
        assert_eq!(bearer_token(&headers).as_deref(), Some("abc123"));

        headers.insert(http::header::AUTHORIZATION, "Basic abc123".parse().unwrap());
        assert_eq!(bearer_token(&headers), None);

        headers.insert(http::header::AUTHORIZATION, "Bearer ".parse().unwrap());
        assert_eq!(bearer_token(&headers), None);
    }

    #[test]
    fn taking_a_header_removes_it() {
        let mut headers = HeaderMap::new();
        headers.insert(PREVIEW_TOKEN_HEADER, "secret-token".parse().unwrap());

        assert_eq!(
            take_header(&mut headers, PREVIEW_TOKEN_HEADER).as_deref(),
            Some("secret-token")
        );
        assert!(
            headers.get(PREVIEW_TOKEN_HEADER).is_none(),
            "the credential must not reach the box"
        );
    }

    #[test]
    fn strips_only_the_consumed_query_parameter() {
        let mut request = Request::builder()
            .uri("http://host/app?a=1&BOXLITE_BOX_AUTH_KEY=secret&b=2")
            .body(())
            .unwrap();

        strip_query_param(&mut request, PREVIEW_TOKEN_QUERY_PARAM).expect("rewrites");

        assert_eq!(request.uri().query(), Some("a=1&b=2"));
        assert_eq!(request.uri().path(), "/app");
    }

    #[test]
    fn stripping_the_only_query_parameter_leaves_no_question_mark() {
        let mut request = Request::builder()
            .uri("http://host/app?BOXLITE_BOX_AUTH_KEY=secret")
            .body(())
            .unwrap();

        strip_query_param(&mut request, PREVIEW_TOKEN_QUERY_PARAM).expect("rewrites");

        assert_eq!(request.uri().path_and_query().unwrap().as_str(), "/app");
    }
}
