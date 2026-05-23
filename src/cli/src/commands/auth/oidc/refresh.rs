//! Proactive refresh-token exchange.
//!
//! Called from `credentials::load_active` whenever a stored OIDC profile's
//! access token is within five minutes of `expires_at`. The five-minute
//! skew matches what Auth0 and Dex use internally to mark tokens stale
//! and is the same window the Go CLI applies (`apps/cli/auth/auth.go:104`).
//!
//! Failure modes:
//!  - **`invalid_grant`** (refresh token revoked or expired) → the caller
//!    is told to re-run `boxlite auth login`. The OIDC fields on the
//!    profile get cleared so a follow-up `auth status` correctly reports
//!    the session as gone.
//!  - **Network / IdP unreachable** → bubble the error up; the caller
//!    decides whether to fall back to the (now-expired) token or refuse.

use anyhow::{Result, anyhow};
use chrono::{Duration as ChronoDuration, Utc};
use openidconnect::core::CoreClient;
use openidconnect::{OAuth2TokenResponse, RefreshToken, TokenResponse};
use secrecy::{ExposeSecret, SecretString};

use super::{OidcConfig, OidcTokens, discovery};
use crate::credentials::Profile;

/// Refresh window: if the access token will expire within this many
/// minutes, refresh now rather than risk a 401 mid-request.
const REFRESH_SKEW_MINUTES: i64 = 5;

/// Returns `true` when the profile has an OIDC session whose access
/// token is within [`REFRESH_SKEW_MINUTES`] of expiring. `false` when
/// the profile is not OIDC or the token is still fresh — the caller can
/// skip the network round-trip.
pub fn refresh_needed(profile: &Profile) -> bool {
    if !matches!(profile.auth_method, crate::credentials::AuthMethod::Oidc) {
        return false;
    }
    let Some(expires_at) = profile.expires_at else {
        // OIDC session with no `expires_at` — treat as already-expired so
        // the next call forces a fresh login if the refresh path fails.
        return true;
    };
    let cutoff = Utc::now() + ChronoDuration::minutes(REFRESH_SKEW_MINUTES);
    expires_at <= cutoff
}

/// Exchange the profile's `refresh_token` for a new access token (and
/// possibly a new refresh token — IdPs may rotate).
///
/// Updates the passed-in `profile` in place on success. On
/// `invalid_grant`, clears the OIDC fields and surfaces a focused error
/// so the caller can prompt re-login.
pub async fn refresh(profile: &mut Profile, http: &reqwest::Client) -> Result<()> {
    let Some(refresh_token) = profile
        .refresh_token
        .as_ref()
        .map(|s| s.expose_secret().to_string())
    else {
        return Err(anyhow!(
            "no refresh_token in profile — run `boxlite auth login` to reauthenticate"
        ));
    };
    let cfg = oidc_config_from_profile(profile)?;
    let metadata = discovery::load_provider_metadata(&cfg, http).await?;
    let client = CoreClient::from_provider_metadata(metadata, cfg.client_id.clone(), None);

    let refresh = RefreshToken::new(refresh_token);
    let request = client
        .exchange_refresh_token(&refresh)
        .map_err(|e| anyhow!("building refresh-token request: {e}"))?;

    let response = match request.request_async(http).await {
        Ok(r) => r,
        Err(err) => {
            // openidconnect maps IdP-rejected refresh attempts to
            // `ServerResponse(StandardErrorResponse { error: invalid_grant, ... })`.
            // Match on the stringified form so we don't depend on
            // upstream's exact error enum shape across crate versions.
            let msg = err.to_string();
            if msg.contains("invalid_grant") {
                clear_oidc_session(profile);
                return Err(anyhow!(
                    "session expired (refresh token rejected); run `boxlite auth login`"
                ));
            }
            return Err(anyhow!("refreshing OIDC session: {err}"));
        }
    };

    profile.access_token = Some(SecretString::from(response.access_token().secret().clone()));
    // IdPs MAY rotate the refresh token; if they do, replace ours.
    if let Some(rt) = response.refresh_token() {
        profile.refresh_token = Some(SecretString::from(rt.secret().clone()));
    }
    if let Some(it) = response.id_token() {
        profile.id_token = Some(SecretString::from(it.to_string()));
    }
    let new_expiry = response
        .expires_in()
        .and_then(|d| ChronoDuration::from_std(d).ok())
        .map(|d| Utc::now() + d)
        // No `expires_in` from the IdP → keep the old value rather than
        // make one up; the next call will retry refresh.
        .or(profile.expires_at);
    profile.expires_at = new_expiry;
    Ok(())
}

/// Convert a stored `Profile` back into an `OidcConfig` suitable for the
/// refresh round-trip. Mirrors what `discovery::resolve_config` produces;
/// returns an error if the profile is missing the issuer / client_id
/// fields (which means it was not actually saved by an OIDC flow).
fn oidc_config_from_profile(profile: &Profile) -> Result<OidcConfig> {
    let issuer = profile
        .oidc_issuer
        .as_ref()
        .ok_or_else(|| anyhow!("profile is missing oidc_issuer; cannot refresh"))?;
    let client_id = profile
        .client_id
        .as_ref()
        .ok_or_else(|| anyhow!("profile is missing client_id; cannot refresh"))?;
    let issuer_url = openidconnect::IssuerUrl::new(issuer.clone())
        .map_err(|e| anyhow!("stored OIDC issuer is not a valid URL: {e}"))?;
    Ok(OidcConfig {
        issuer: issuer_url,
        client_id: openidconnect::ClientId::new(client_id.clone()),
        audience: profile.audience.clone(),
        scopes: OidcConfig::default_scopes(),
    })
}

/// Wipe every OIDC field from `profile`. Leaves `url` and `auth_method`
/// intact (the caller often wants to know "this profile *used to* hold an
/// OIDC session" to decide between deletion and re-login prompt).
fn clear_oidc_session(profile: &mut Profile) {
    profile.access_token = None;
    profile.refresh_token = None;
    profile.id_token = None;
    profile.expires_at = None;
    profile.oidc_issuer = None;
    profile.client_id = None;
    profile.audience = None;
}

/// Fold OIDC tokens (from auth-code or device-code) into a Profile. Used
/// at the end of both interactive flows so the on-disk shape is computed
/// in one place — keeps the contract `refresh_needed` / `refresh` reads
/// stable.
pub fn apply_tokens(profile: &mut Profile, cfg: &OidcConfig, tokens: OidcTokens) {
    profile.auth_method = crate::credentials::AuthMethod::Oidc;
    profile.api_key = None;
    profile.access_token = Some(tokens.access_token);
    profile.refresh_token = tokens.refresh_token;
    profile.id_token = tokens.id_token;
    profile.expires_at = Some(tokens.expires_at);
    profile.oidc_issuer = Some(cfg.issuer.as_str().to_string());
    profile.client_id = Some(cfg.client_id.as_str().to_string());
    profile.audience = cfg.audience.clone();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::credentials::{AuthMethod, Profile};

    fn oidc_profile_with_expiry(expires_at: chrono::DateTime<Utc>) -> Profile {
        Profile {
            url: "https://api.boxlite.ai/api".to_string(),
            access_token: Some(SecretString::from("at".to_string())),
            refresh_token: Some(SecretString::from("rt".to_string())),
            expires_at: Some(expires_at),
            oidc_issuer: Some("https://dex.boxlite.ai/dex".to_string()),
            client_id: Some("boxlite".to_string()),
            auth_method: AuthMethod::Oidc,
            ..Profile::default()
        }
    }

    /// Within the 5-min skew → refresh now.
    #[test]
    fn refresh_needed_when_token_expires_within_skew() {
        let near_future = Utc::now() + ChronoDuration::minutes(2);
        assert!(refresh_needed(&oidc_profile_with_expiry(near_future)));
    }

    /// Plenty of headroom → don't burn a network call.
    #[test]
    fn refresh_not_needed_for_long_lived_token() {
        let far_future = Utc::now() + ChronoDuration::hours(2);
        assert!(!refresh_needed(&oidc_profile_with_expiry(far_future)));
    }

    /// API-key profiles never refresh — guards against future code that
    /// blindly calls `refresh_needed` on every load.
    #[test]
    fn api_key_profile_never_needs_refresh() {
        let mut p = oidc_profile_with_expiry(Utc::now() - ChronoDuration::hours(1));
        p.auth_method = AuthMethod::ApiKey;
        assert!(!refresh_needed(&p));
    }

    /// OIDC profile with no `expires_at` is treated as already-expired —
    /// safer than holding an unbounded "is it still good?" question.
    #[test]
    fn missing_expires_at_treated_as_expired() {
        let mut p = oidc_profile_with_expiry(Utc::now() + ChronoDuration::hours(1));
        p.expires_at = None;
        assert!(refresh_needed(&p));
    }

    /// Clearing the OIDC session preserves the URL + auth_method discriminator
    /// so `auth status` can still say "this profile *was* OIDC".
    #[test]
    fn clear_oidc_session_keeps_url_and_method() {
        let mut p = oidc_profile_with_expiry(Utc::now());
        clear_oidc_session(&mut p);
        assert_eq!(p.url, "https://api.boxlite.ai/api");
        assert!(p.access_token.is_none());
        assert!(p.refresh_token.is_none());
        assert!(p.oidc_issuer.is_none());
    }

    /// `apply_tokens` is the inverse of the persisted shape `refresh` reads —
    /// confirms the round trip stays internally consistent so a refresh
    /// can immediately be followed by another refresh.
    #[test]
    fn apply_tokens_populates_all_oidc_fields() {
        let mut p = Profile {
            url: "https://api.boxlite.ai/api".to_string(),
            ..Profile::default()
        };
        let cfg = OidcConfig {
            issuer: openidconnect::IssuerUrl::new("https://dex.boxlite.ai/dex".to_string())
                .unwrap(),
            client_id: openidconnect::ClientId::new("boxlite".to_string()),
            audience: Some("boxlite-api".to_string()),
            scopes: OidcConfig::default_scopes(),
        };
        let tokens = OidcTokens {
            access_token: SecretString::from("AT".to_string()),
            refresh_token: Some(SecretString::from("RT".to_string())),
            id_token: Some(SecretString::from("ID".to_string())),
            expires_at: Utc::now() + ChronoDuration::hours(1),
        };
        apply_tokens(&mut p, &cfg, tokens);
        assert_eq!(p.auth_method, AuthMethod::Oidc);
        assert!(p.api_key.is_none());
        assert_eq!(
            p.access_token.as_ref().map(|s| s.expose_secret()),
            Some("AT")
        );
        assert_eq!(p.oidc_issuer.as_deref(), Some("https://dex.boxlite.ai/dex"));
        assert_eq!(p.client_id.as_deref(), Some("boxlite"));
        assert_eq!(p.audience.as_deref(), Some("boxlite-api"));
    }
}
