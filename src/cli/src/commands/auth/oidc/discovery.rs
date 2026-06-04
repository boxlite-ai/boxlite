//! Figure out which OIDC IdP to authenticate against.
//!
//! Two layers:
//!
//! 1. [`resolve_config`] picks the issuer / client_id / audience from the
//!    user's CLI flags, the control plane's `GET /api/config` response, or
//!    `OIDC_*` env vars — in that precedence order.
//! 2. [`load_provider_metadata`] turns the resolved issuer URL into a full
//!    OIDC well-known document, so the auth-code and device-code flows know
//!    where to send the user.
//!
//! Splitting the two lets tests stub out the well-known fetch with the
//! existing `Stub` HTTP server in `tests/auth.rs` without also having to
//! re-implement `/api/config`.

use anyhow::{Context, Result, anyhow};
use openidconnect::{ClientId, IssuerUrl, core::CoreProviderMetadata};
use serde::Deserialize;

use super::{DiscoveryOverrides, OidcConfig};

/// Environment-variable fallbacks used when neither the CLI flags nor
/// `GET /api/config` supply a value. Names match what `apps/cli` reads
/// from its build-info defaults so a user with these env vars set already
/// works against the Rust CLI unchanged.
const ISSUER_ENV: &str = "OIDC_ISSUER";
const CLIENT_ID_ENV: &str = "OIDC_CLIENT_ID";
const AUDIENCE_ENV: &str = "OIDC_AUDIENCE";

/// Shape of `GET {server_url}/config` on the apps/api control plane. We
/// only deserialize the fields we care about so a future schema extension
/// doesn't break the CLI.
#[derive(Debug, Deserialize)]
struct ServerConfig {
    oidc: Option<ServerOidcConfig>,
}

#[derive(Debug, Deserialize)]
struct ServerOidcConfig {
    issuer: Option<String>,
    #[serde(rename = "clientId", alias = "client_id")]
    client_id: Option<String>,
    audience: Option<String>,
}

/// Resolve the OIDC parameters for a login attempt.
///
/// Per source, precedence is **flag > server config > env**:
///
/// - explicit `--issuer/--client-id/--audience` always win;
/// - then `GET {server_url}/config` (the apps/api endpoint at
///   `apps/api/src/config/config.controller.ts:21-31`);
/// - finally `OIDC_ISSUER` / `OIDC_CLIENT_ID` / `OIDC_AUDIENCE` env vars,
///   matching the Go CLI's build-info defaults.
///
/// `server_url` is expected to be the same value passed to `--url` (e.g.
/// `https://api.boxlite.ai/api`). When the server lookup fails (offline,
/// older boxlite serve that doesn't expose `/config`) we silently fall
/// through to env vars; if nothing supplies an issuer the caller gets an
/// `anyhow::Error` with the list of sources we tried.
pub async fn resolve_config(
    server_url: &str,
    overrides: &DiscoveryOverrides,
    http: &reqwest::Client,
) -> Result<OidcConfig> {
    let server_cfg = fetch_server_oidc(server_url, http).await;
    let issuer_env = std::env::var(ISSUER_ENV).ok();
    let client_id_env = std::env::var(CLIENT_ID_ENV).ok();
    let audience_env = std::env::var(AUDIENCE_ENV).ok();

    let issuer = pick(
        overrides.issuer.as_deref(),
        server_cfg.as_ref().and_then(|c| c.issuer.as_deref()),
        issuer_env.as_deref(),
    )
    .ok_or_else(|| {
        anyhow!(
            "no OIDC issuer found; pass --issuer, configure {ISSUER_ENV}, or point --url at a \
             control plane that exposes /config"
        )
    })?;

    let client_id = pick(
        overrides.client_id.as_deref(),
        server_cfg.as_ref().and_then(|c| c.client_id.as_deref()),
        client_id_env.as_deref(),
    )
    .ok_or_else(|| {
        anyhow!("no OIDC client_id found; pass --client-id or configure {CLIENT_ID_ENV}")
    })?;

    let audience = pick(
        overrides.audience.as_deref(),
        server_cfg.as_ref().and_then(|c| c.audience.as_deref()),
        audience_env.as_deref(),
    )
    .map(str::to_string);

    let issuer_url = IssuerUrl::new(issuer.to_string())
        .with_context(|| format!("invalid OIDC issuer URL: {issuer}"))?;

    Ok(OidcConfig {
        issuer: issuer_url,
        client_id: ClientId::new(client_id.to_string()),
        audience,
        scopes: OidcConfig::default_scopes(),
    })
}

/// Fetch and parse the OIDC well-known document for the resolved issuer.
///
/// Kept separate from `resolve_config` so tests can build an `OidcConfig`
/// pointing at a fake Dex (`tests/auth.rs::Stub`) and then call
/// `load_provider_metadata` against the same stub, without needing the
/// `/api/config` step at all.
///
/// Handles the Auth0 quirk where its discovery doc returns the issuer
/// WITH a trailing slash even though operators commonly configure it
/// WITHOUT one in their `/api/config`. The openidconnect validator demands
/// byte-for-byte equality, so if we get the "Issuer did not match" error
/// we retry once with the trailing slash toggled. One round of fallback
/// only — if the second attempt still fails the error is something else
/// and bubbles up.
pub async fn load_provider_metadata(
    cfg: &OidcConfig,
    http: &reqwest::Client,
) -> Result<CoreProviderMetadata> {
    match CoreProviderMetadata::discover_async(cfg.issuer.clone(), http).await {
        Ok(metadata) => Ok(metadata),
        Err(err) if is_issuer_mismatch(&err) => {
            let toggled = toggle_trailing_slash(cfg.issuer.as_str());
            let retry_issuer = openidconnect::IssuerUrl::new(toggled.clone())
                .with_context(|| format!("invalid retry issuer URL: {toggled}"))?;
            CoreProviderMetadata::discover_async(retry_issuer, http)
                .await
                .with_context(|| {
                    format!(
                        "fetching OIDC discovery document from {}/.well-known/openid-configuration \
                         (first attempt failed with issuer mismatch; retried with trailing slash \
                         toggled to {toggled})",
                        cfg.issuer.as_str().trim_end_matches('/')
                    )
                })
        }
        Err(err) => Err(anyhow!(
            "fetching OIDC discovery document from {}/.well-known/openid-configuration: {err}",
            cfg.issuer.as_str().trim_end_matches('/')
        )),
    }
}

/// Detect the openidconnect 4.x error variant for "discovery doc issuer
/// did not match the URL we used". We match on the stringified form so
/// we don't depend on the crate's exact error enum shape across versions.
///
/// Known wordings across crate versions:
///  - 4.x  : `Validation error: unexpected issuer URI \`X\` (expected \`Y\`)`
///  - 3.x  : `Issuer URL did not match`
///  - generic: anything mentioning "issuer" together with "expected" / "match"
///
/// Lowercase-comparison keeps us robust to capitalization changes.
fn is_issuer_mismatch<E: std::fmt::Display>(err: &E) -> bool {
    let s = err.to_string().to_ascii_lowercase();
    s.contains("issuer")
        && (s.contains("unexpected")
            || s.contains("did not match")
            || s.contains("mismatch")
            || s.contains("expected"))
}

/// Add or remove the trailing slash on an issuer URL, preserving the rest.
/// Used by [`load_provider_metadata`]'s retry to handle Auth0's
/// "iss ends with /" convention vs. Dex / Okta's "iss has no trailing /"
/// convention without forcing operators to know which family their IdP
/// belongs to.
fn toggle_trailing_slash(url: &str) -> String {
    if let Some(stripped) = url.strip_suffix('/') {
        stripped.to_string()
    } else {
        format!("{url}/")
    }
}

/// Pull the OIDC sub-object out of `{server_url}/config`. Errors are
/// swallowed because the server-supplied config is one of three sources;
/// a 404 from an older boxlite serve is the expected case, not a failure.
async fn fetch_server_oidc(server_url: &str, http: &reqwest::Client) -> Option<ServerOidcConfig> {
    let url = join_config_url(server_url).ok()?;
    let resp = http.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let cfg: ServerConfig = resp.json().await.ok()?;
    cfg.oidc
}

/// Compute the `/config` URL from a server base URL, preserving any prefix
/// (e.g. `https://api.boxlite.ai/api/config`). `reqwest::Url::join` would
/// strip the trailing path segment when the base lacks a trailing slash, so
/// we append explicitly.
fn join_config_url(server_url: &str) -> Result<url::Url> {
    let trimmed = server_url.trim_end_matches('/');
    let joined = format!("{trimmed}/config");
    url::Url::parse(&joined).with_context(|| format!("invalid server URL: {server_url}"))
}

/// First non-empty option, in source order. `None` and `Some("")` both
/// count as absent — keeps `OIDC_AUDIENCE=` (unset-by-shell-quirk) from
/// being treated as a real value.
fn pick<'a>(
    flag: Option<&'a str>,
    server: Option<&'a str>,
    env: Option<&'a str>,
) -> Option<&'a str> {
    [flag, server, env]
        .into_iter()
        .flatten()
        .find(|s| !s.is_empty())
}

/// Helper used by callers that just need "give me a default reqwest client
/// suitable for OIDC". Kept here so flow modules don't duplicate the
/// timeout / user-agent decisions.
pub fn http_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(concat!("boxlite-cli/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(20))
        // OAuth callback URIs (and Dex / Auth0 token endpoints) MUST NOT be
        // redirected — preventing open-redirect attacks is on us, not the
        // IdP. `openidconnect` documents this requirement.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| anyhow!("building HTTP client: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_prefers_flag_over_server_and_env() {
        assert_eq!(
            pick(Some("flag"), Some("server"), Some("env")),
            Some("flag")
        );
    }

    #[test]
    fn pick_falls_through_empty_strings() {
        // `Some("")` is treated as absent so a stray `--audience=` or
        // `OIDC_AUDIENCE=` shell artifact does not silently win.
        assert_eq!(pick(Some(""), Some("server"), Some("env")), Some("server"));
        assert_eq!(pick(None, Some(""), Some("env")), Some("env"));
        assert_eq!(pick(None, None, Some("")), None);
    }

    #[test]
    fn join_config_url_appends_to_prefix() {
        let u = join_config_url("https://api.boxlite.ai/api").unwrap();
        assert_eq!(u.as_str(), "https://api.boxlite.ai/api/config");
    }

    #[test]
    fn join_config_url_strips_trailing_slash() {
        let u = join_config_url("https://api.boxlite.ai/api/").unwrap();
        assert_eq!(u.as_str(), "https://api.boxlite.ai/api/config");
    }

    /// Toggle is an involution — runs once to add, again to remove.
    /// Locks in the contract that the retry path expects exactly one
    /// alternate form per issuer URL.
    #[test]
    fn toggle_trailing_slash_round_trips() {
        let no_slash = "https://issuer.example.com";
        let with_slash = "https://issuer.example.com/";
        assert_eq!(toggle_trailing_slash(no_slash), with_slash);
        assert_eq!(toggle_trailing_slash(with_slash), no_slash);
        assert_eq!(
            toggle_trailing_slash(&toggle_trailing_slash(no_slash)),
            no_slash
        );
    }

    /// The mismatch detector keys on the openidconnect 4.x error wording.
    /// If that wording changes in a future crate version this test goes
    /// red and we know to update the matcher rather than silently lose
    /// the Auth0 retry path.
    #[test]
    fn is_issuer_mismatch_recognizes_openidconnect_error_shape() {
        struct E(&'static str);
        impl std::fmt::Display for E {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.0)
            }
        }
        // openidconnect 4.x wording (the one we hit in production today).
        assert!(is_issuer_mismatch(&E(
            "Validation error: unexpected issuer URI `https://x/` (expected `https://x`)"
        )));
        // openidconnect 3.x wording, kept for upgrade safety.
        assert!(is_issuer_mismatch(&E(
            "Issuer URL in provider metadata did not match expected value"
        )));
        // Not a mismatch — make sure unrelated errors don't trigger the retry.
        assert!(!is_issuer_mismatch(&E("connection refused")));
        assert!(!is_issuer_mismatch(&E("invalid JSON in discovery doc")));
    }
}
