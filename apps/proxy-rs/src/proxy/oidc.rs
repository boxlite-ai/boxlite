// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: Apache-2.0

//! Interactive login for private preview URLs.
//!
//! When a browser reaches a private box with no preview token, it is sent
//! through the organisation's OIDC provider. The proxy only needs an access
//! token it can present to the BoxLite API — it never validates ID tokens
//! itself, so it uses the authorization-code flow with PKCE and treats the
//! provider's endpoints as the only thing discovery has to supply.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use rand::TryRngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;

use crate::config::OidcConfig;
use crate::error::{ProxyError, Result};

const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(10);
const TOKEN_EXCHANGE_TIMEOUT: Duration = Duration::from_secs(30);

/// The endpoints the proxy uses, after any split-horizon rewriting.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoints {
    /// Where the browser is sent. Always the publicly reachable address.
    pub authorization: String,
    /// Where the proxy exchanges the code. May be an internal address.
    pub token: String,
}

/// PKCE material for one login attempt.
pub struct LoginRequest {
    pub authorization_url: String,
    pub code_verifier: String,
}

pub struct OidcProvider {
    config: OidcConfig,
    http: reqwest::Client,
    /// Discovery documents are static in practice, and re-fetching one on every
    /// redirect would put the provider in the path of each unauthenticated hit.
    endpoints: RwLock<Option<Arc<Endpoints>>>,
}

impl OidcProvider {
    pub fn new(config: OidcConfig) -> std::result::Result<Self, reqwest::Error> {
        Ok(Self {
            config,
            http: reqwest::Client::builder()
                .timeout(TOKEN_EXCHANGE_TIMEOUT)
                .build()?,
            endpoints: RwLock::new(None),
        })
    }

    /// Builds the URL that starts a login, plus the verifier that must come back
    /// with the code.
    pub async fn start_login(&self, redirect_uri: &str, state: &str) -> Result<LoginRequest> {
        let endpoints = self.endpoints().await?;
        let code_verifier = random_token();

        let mut url = format!(
            "{}?response_type=code&client_id={}&redirect_uri={}&scope={}&state={}&code_challenge={}&code_challenge_method=S256",
            endpoints.authorization,
            escape(&self.config.client_id),
            escape(redirect_uri),
            escape("openid profile"),
            escape(state),
            escape(&code_challenge(&code_verifier)),
        );
        if !self.config.audience.is_empty() {
            url.push_str(&format!("&audience={}", escape(&self.config.audience)));
        }

        Ok(LoginRequest {
            authorization_url: url,
            code_verifier,
        })
    }

    /// Trades an authorization code for an access token.
    pub async fn exchange_code(
        &self,
        code: &str,
        code_verifier: &str,
        redirect_uri: &str,
    ) -> Result<String> {
        #[derive(Deserialize)]
        struct TokenResponse {
            access_token: String,
        }

        let endpoints = self.endpoints().await?;
        let mut form = vec![
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", self.config.client_id.as_str()),
            ("code_verifier", code_verifier),
        ];
        // Absent for public clients, which authenticate with PKCE alone.
        if !self.config.client_secret.is_empty() {
            form.push(("client_secret", self.config.client_secret.as_str()));
        }

        let response = self
            .http
            .post(&endpoints.token)
            .form(&form)
            .send()
            .await
            .map_err(|err| ProxyError::bad_request(format!("failed to exchange token: {err}")))?;

        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if !status.is_success() {
            // The body carries the provider's `error` / `error_description`,
            // which is the only useful signal for a misconfigured client.
            return Err(ProxyError::bad_request(format!(
                "failed to exchange token: provider returned {status}: {body}"
            )));
        }

        serde_json::from_str::<TokenResponse>(&body)
            .map(|token| token.access_token)
            .map_err(|err| ProxyError::bad_request(format!("failed to exchange token: {err}")))
    }

    async fn endpoints(&self) -> Result<Arc<Endpoints>> {
        if let Some(cached) = self.endpoints.read().await.clone() {
            return Ok(cached);
        }

        let discovered = Arc::new(self.discover().await?);
        *self.endpoints.write().await = Some(discovered.clone());
        Ok(discovered)
    }

    async fn discover(&self) -> Result<Endpoints> {
        #[derive(Deserialize)]
        struct Document {
            issuer: String,
            authorization_endpoint: String,
            token_endpoint: String,
        }

        let url = format!(
            "{}/.well-known/openid-configuration",
            self.config.domain.trim_end_matches('/')
        );
        let document: Document = self
            .http
            .get(&url)
            .timeout(DISCOVERY_TIMEOUT)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|err| {
                ProxyError::internal(format!("failed to initialize OIDC provider: {err}"))
            })?
            .json()
            .await
            .map_err(|err| {
                ProxyError::internal(format!("failed to initialize OIDC provider: {err}"))
            })?;

        // With a split-horizon issuer the document legitimately advertises the
        // public address while we fetched the internal one, so the check only
        // applies when there is one address.
        match &self.config.public_domain {
            Some(public_domain) if !public_domain.is_empty() => {
                return Ok(Endpoints {
                    authorization: document.authorization_endpoint,
                    token: document.token_endpoint.replace(
                        public_domain.as_str(),
                        self.config.domain.trim_end_matches('/'),
                    ),
                });
            }
            _ => {}
        }

        if document.issuer.trim_end_matches('/') != self.config.domain.trim_end_matches('/') {
            return Err(ProxyError::internal(format!(
                "OIDC issuer mismatch: configured {}, provider reports {}",
                self.config.domain, document.issuer
            )));
        }

        Ok(Endpoints {
            authorization: document.authorization_endpoint,
            token: document.token_endpoint,
        })
    }
}

/// 256 bits of entropy, rendered in the unreserved character set RFC 7636
/// requires of a code verifier.
pub fn random_token() -> String {
    let mut bytes = [0_u8; 32];
    rand::rngs::OsRng
        .try_fill_bytes(&mut bytes)
        .expect("the OS random source is available");
    BASE64.encode(bytes)
}

fn code_challenge(verifier: &str) -> String {
    BASE64.encode(Sha256::digest(verifier.as_bytes()))
}

fn escape(value: &str) -> String {
    utf8_percent_encode(value, NON_ALPHANUMERIC).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_the_s256_challenge_from_the_verifier() {
        // RFC 7636 appendix B test vector.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";

        assert_eq!(
            code_challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn verifiers_are_unique_and_url_safe() {
        let first = random_token();
        let second = random_token();

        assert_ne!(first, second);
        assert_eq!(first.len(), 43, "32 bytes of base64url without padding");
        assert!(
            first
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'),
            "got {first}"
        );
    }
}
