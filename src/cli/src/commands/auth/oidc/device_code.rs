//! Device Authorization Grant (RFC 8628) — the headless / SSH-friendly
//! cousin of the browser flow.
//!
//! The IdP gives us a short `user_code` and a `verification_uri`; we print
//! both, the user types the code into the URL on any device that has a
//! browser, and meanwhile we poll the token endpoint. The polling itself —
//! including `authorization_pending` / `slow_down` / `expires_in` —
//! happens inside `openidconnect`, so this module is mostly UX glue.

use anyhow::{Context, Result, anyhow};
use chrono::{TimeDelta, Utc};
use openidconnect::core::{CoreClient, CoreDeviceAuthorizationResponse};
use openidconnect::{DeviceAuthorizationUrl, OAuth2TokenResponse, Scope, TokenResponse};
use secrecy::SecretString;

use super::{OidcConfig, OidcTokens};

/// Run the Device Code flow.
///
/// The flow is fully self-contained: nothing in this function depends on
/// the local machine having a browser. We do best-effort try to open the
/// `verification_uri_complete` if the IdP returns one (it pre-fills the
/// user code) — but if `webbrowser::open` fails, the printed text is the
/// real interface.
pub async fn run(cfg: &OidcConfig, http: &reqwest::Client) -> Result<OidcTokens> {
    let metadata = super::discovery::load_provider_metadata(cfg, http).await?;

    // The device-authorization endpoint isn't part of the OIDC core
    // discovery doc, so `CoreProviderMetadata` doesn't expose it. Both Dex
    // and Auth0 use the conventional `{issuer}/device/code` path; if a
    // future IdP requires something different we can add `--device-endpoint`
    // before adopting a custom `AdditionalProviderMetadata` struct.
    let device_url = conventional_device_endpoint(cfg)?;
    let client = CoreClient::from_provider_metadata(metadata, cfg.client_id.clone(), None)
        .set_device_authorization_url(device_url);

    let mut request = client
        .exchange_device_code()
        .add_extra_param("client_id", cfg.client_id.as_str());
    for scope in &cfg.scopes {
        request = request.add_scope(Scope::new(scope.clone()));
    }
    if let Some(audience) = cfg.audience.as_deref() {
        request = request.add_extra_param("audience", audience);
    }

    let details: CoreDeviceAuthorizationResponse = request
        .request_async(http)
        .await
        .map_err(|e| anyhow!("requesting device code: {e}"))?;

    print_user_instructions(&details);

    // `openidconnect` handles the entire poll loop (authorization_pending,
    // slow_down back-off, the `expires_in` deadline). We only supply the
    // sleep primitive — `tokio::time::sleep` — and an optional upper bound.
    let token_response = client
        .exchange_device_access_token(&details)
        .context("building device-access-token request")?
        .request_async(http, tokio::time::sleep, None)
        .await
        .map_err(|e| anyhow!("polling for device token: {e}"))?;

    Ok(tokens_from_response(&token_response))
}

/// Pretty-print the URL + user code so the user can complete the flow.
/// Stays on stderr so structured-stdout consumers don't get noise.
fn print_user_instructions(details: &CoreDeviceAuthorizationResponse) {
    let verification_uri = details.verification_uri().as_str();
    let user_code = details.user_code().secret();

    eprintln!();
    eprintln!("To finish logging in, open this URL in any browser:");
    eprintln!("    {verification_uri}");
    eprintln!("and enter this one-time code:");
    eprintln!("    {user_code}");

    if let Some(complete) = details.verification_uri_complete() {
        let complete = complete.secret();
        eprintln!();
        eprintln!("Or open this single-step URL (the code is pre-filled):");
        eprintln!("    {complete}");
        // Best-effort: on a desktop terminal where a browser *is* available
        // this is a nicer UX. We fail silently because the printed URL is
        // the actual interface — opening a browser is a convenience.
        let _ = webbrowser::open(complete);
    }
    eprintln!();
}

/// Build the device-authorization endpoint by convention. Dex serves it at
/// `{issuer}/device/code`; Auth0 at `{issuer}/oauth/device/code`. We send to
/// the Dex form because that is the deployment this CLI targets; Auth0
/// users can override via a future `--device-endpoint` flag.
fn conventional_device_endpoint(cfg: &OidcConfig) -> Result<DeviceAuthorizationUrl> {
    let url = format!("{}/device/code", cfg.issuer.as_str().trim_end_matches('/'));
    DeviceAuthorizationUrl::new(url.clone())
        .with_context(|| format!("invalid device authorization URL: {url}"))
}

fn tokens_from_response(resp: &openidconnect::core::CoreTokenResponse) -> OidcTokens {
    let expires_in = resp
        .expires_in()
        .and_then(|d| TimeDelta::from_std(d).ok())
        .unwrap_or(TimeDelta::minutes(5));
    OidcTokens {
        access_token: SecretString::from(resp.access_token().secret().clone()),
        refresh_token: resp
            .refresh_token()
            .map(|t| SecretString::from(t.secret().clone())),
        id_token: resp.id_token().map(|t| SecretString::from(t.to_string())),
        expires_at: Utc::now() + expires_in,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fallback URL must produce a parseable `DeviceAuthorizationUrl`
    /// for the issuer shape Dex serves. Guards against accidental
    /// trailing-slash regressions.
    #[test]
    fn conventional_endpoint_handles_trailing_slash() {
        let cfg = OidcConfig {
            issuer: openidconnect::IssuerUrl::new("https://dex.boxlite.ai/dex/".to_string())
                .unwrap(),
            client_id: openidconnect::ClientId::new("boxlite".to_string()),
            audience: None,
            scopes: vec![],
        };
        let url = conventional_device_endpoint(&cfg).unwrap();
        assert_eq!(url.as_str(), "https://dex.boxlite.ai/dex/device/code");
    }
}
