// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! The browser login round trip.
//!
//! Two halves of one flow: send an unauthenticated browser to the identity
//! provider, and handle the redirect back. Everything the second half needs is
//! carried in the `state` parameter, signed so the browser cannot rewrite where
//! it will be sent afterwards or which box it is claiming.

use std::net::SocketAddr;

use http::{Request, Response, StatusCode};
use serde::{Deserialize, Serialize};

use crate::body::Body;
use crate::error::{ProxyError, Result};
use crate::response::{self, CookieOptions};

use super::auth::BOX_AUTH_COOKIE_PREFIX;
use super::host::query_param;
use super::{OIDC_STATE_NAME, PKCE_COOKIE_MAX_AGE, PKCE_COOKIE_NAME, Proxy, host};

/// What the proxy needs back from the identity provider, beyond the code.
#[derive(Serialize, Deserialize)]
struct LoginState {
    /// Where to send the browser once it is authenticated.
    return_to: String,
    /// The box the login is for, as it appeared in the hostname.
    box_id: String,
    /// Makes each login attempt's state unique.
    nonce: String,
}

impl Proxy {
    pub(super) async fn login_redirect<B>(
        &self,
        request: &Request<B>,
        box_id_or_token: &str,
        request_host: &str,
    ) -> Result<Response<Body>> {
        let base_host = host::parse_host(request_host)?.base_host;
        let protocol = &self.config.proxy_protocol;

        let state = serde_json::to_string(&LoginState {
            return_to: format!(
                "{protocol}://{request_host}{}",
                request
                    .uri()
                    .path_and_query()
                    .map(|target| target.as_str())
                    .unwrap_or("/")
            ),
            box_id: box_id_or_token.to_string(),
            nonce: super::oidc::random_token(),
        })
        .map_err(|err| ProxyError::internal(format!("failed to build login state: {err}")))?;

        // The callback is served on the base domain, so that is the redirect URI
        // the provider must have registered — not the per-box subdomain.
        let login = self
            .oidc
            .start_login(
                &format!("{protocol}://{base_host}/callback"),
                &self.signer.encode(OIDC_STATE_NAME, &state),
            )
            .await?;

        let mut redirect =
            response::redirect(StatusCode::TEMPORARY_REDIRECT, &login.authorization_url);
        response::set_cookie(
            &mut redirect,
            PKCE_COOKIE_NAME,
            &self.signer.encode(PKCE_COOKIE_NAME, &login.code_verifier),
            CookieOptions {
                domain: &self.cookie_domain(&base_host),
                max_age: Some(PKCE_COOKIE_MAX_AGE),
                secure: self.config.serves_https(),
                http_only: true,
                same_site: None,
            },
        );

        Ok(redirect)
    }

    pub(super) async fn auth_callback<B>(
        &self,
        request: &Request<B>,
        request_host: &str,
        remote_addr: SocketAddr,
    ) -> Result<Response<Body>> {
        let uri = request.uri();

        if let Some(error) = query_param(uri, "error") {
            let description = query_param(uri, "error_description").unwrap_or(error);
            return Err(ProxyError::unauthorized(description));
        }

        let code = query_param(uri, "code")
            .ok_or_else(|| ProxyError::bad_request("no code in callback"))?;
        let signed_state = query_param(uri, "state")
            .ok_or_else(|| ProxyError::bad_request("no state in callback"))?;

        let state: LoginState = self
            .signer
            .decode(OIDC_STATE_NAME, &signed_state, PKCE_COOKIE_MAX_AGE)
            .map_err(|err| ProxyError::bad_request(format!("invalid callback state: {err}")))
            .and_then(|state| {
                serde_json::from_str(&state).map_err(|err| {
                    ProxyError::bad_request(format!("invalid callback state: {err}"))
                })
            })?;

        // Signing stops a third party from rewriting the state, but not an
        // attacker from minting one: the proxy answers on any hostname, so
        // `return_to` was built from a `Host` header nobody validated.
        if !host::is_same_site(&state.return_to, request_host) {
            return Err(ProxyError::bad_request(
                "callback state points off this proxy",
            ));
        }

        let verifier = response::read_cookie(request.headers(), PKCE_COOKIE_NAME)
            .and_then(|cookie| {
                self.signer
                    .decode(PKCE_COOKIE_NAME, &cookie, PKCE_COOKIE_MAX_AGE)
                    .ok()
            })
            .ok_or_else(|| ProxyError::bad_request("authentication state verification failed"))?;

        let access_token = self
            .oidc
            .exchange_code(
                &code,
                &verifier,
                &format!("{}://{request_host}/callback", self.config.proxy_protocol),
            )
            .await?;

        let has_access = self
            .api
            .has_box_access(
                &state.box_id,
                &access_token,
                super::client_ip(request.headers(), remote_addr).as_deref(),
            )
            .await
            .map_err(|err| ProxyError::internal(format!("failed to verify box access: {err}")))?;
        if !has_access {
            return Err(ProxyError::not_found("box not found"));
        }

        let cookie_domain = self.cookie_domain(request_host);
        let mut redirect = response::redirect(StatusCode::FOUND, &state.return_to);

        // The verifier is single-use; leaving it behind would let a replayed
        // callback re-run the exchange.
        response::set_cookie(
            &mut redirect,
            PKCE_COOKIE_NAME,
            "",
            CookieOptions {
                domain: &cookie_domain,
                max_age: None,
                secure: self.config.serves_https(),
                http_only: true,
                same_site: None,
            },
        );

        let mut cookies = http::HeaderMap::new();
        self.issue_box_auth_cookie(
            &mut cookies,
            &format!("{BOX_AUTH_COOKIE_PREFIX}{}", state.box_id),
            &state.box_id,
            request_host,
        );
        response::merge_headers(&mut redirect, cookies);

        Ok(redirect)
    }
}
