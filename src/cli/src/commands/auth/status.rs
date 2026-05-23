//! `boxlite auth status` — show where credentials come from without revealing
//! secret material.

use anyhow::{Context, Result};

use crate::credentials::{self, AuthMethod};
use crate::defaults::LOCAL_SERVE_URL;

const API_KEY_ENV: &str = "BOXLITE_API_KEY";
const URL_ENV: &str = "BOXLITE_REST_URL";

enum Source {
    /// `BOXLITE_API_KEY` set in the environment.
    EnvApiKey,
    /// On-disk file. `path_display` is the resolved location.
    File { path_display: String },
}

struct Identity {
    url: String,
    source: Source,
    /// `None` for env-derived identities (we don't decorate); `Some` for
    /// file-derived so the user sees whether it's API-key or OIDC and,
    /// for OIDC, when the access token expires.
    method: Option<AuthMethod>,
    expires_at: Option<chrono::DateTime<chrono::Utc>>,
}

pub fn run(profile_name: &str) -> Result<()> {
    let identity = match resolve_identity(profile_name)? {
        Some(id) => id,
        None => {
            println!("Not logged in (profile `{}`).", profile_name);
            return Ok(());
        }
    };

    let source_label = match identity.source {
        Source::EnvApiKey => format!("{} env var", API_KEY_ENV),
        Source::File { path_display } => format!("{} [{}]", path_display, profile_name),
    };

    println!("Logged in to:    {}", identity.url);
    let credential_label = match identity.method {
        Some(AuthMethod::Oidc) => "OIDC bearer token",
        Some(AuthMethod::ApiKey) | None => "API key",
    };
    println!(
        "Credential:      {} (from {})",
        credential_label, source_label
    );
    if let Some(exp) = identity.expires_at {
        println!("Expires:         {}", exp.to_rfc3339());
    }
    Ok(())
}

/// Resolve the active credential source. Env vars win over the file (matches
/// the runtime precedence used by `from_env()`).
fn resolve_identity(profile_name: &str) -> Result<Option<Identity>> {
    // Both `auth whoami` and the runtime in `cli.rs` skip the env path when
    // `BOXLITE_API_KEY` is set-but-empty (`!key.is_empty()`). `auth status`
    // used to short-circuit on a bare `is_ok()` check, so an empty value
    // would report "Logged in (env)" while every subsequent authenticated
    // command would actually fall back to the stored profile. Mirror the
    // canonical check here so `status` agrees with `whoami` / the runtime.
    if let Ok(api_key) = std::env::var(API_KEY_ENV)
        && !api_key.is_empty()
    {
        let url = std::env::var(URL_ENV).unwrap_or_else(|_| LOCAL_SERVE_URL.to_string());
        return Ok(Some(Identity {
            url,
            source: Source::EnvApiKey,
            method: None,
            expires_at: None,
        }));
    }

    let profile = credentials::load_named(profile_name).context("loading stored credentials")?;
    let Some(profile) = profile else {
        return Ok(None);
    };
    let path = credentials::path().context("resolving credentials path")?;
    Ok(Some(Identity {
        url: profile.url,
        source: Source::File {
            path_display: path.display().to_string(),
        },
        method: Some(profile.auth_method),
        expires_at: profile.expires_at,
    }))
}
