//! `boxlite auth status` — show where credentials come from without revealing
//! secret material.

use anyhow::{Context, Result};

use crate::cli::GlobalFlags;
use crate::credentials::{AuthMethod, CredentialStore};
use crate::defaults::LOCAL_SERVE_URL;

const API_KEY_ENV: &str = "BOXLITE_API_KEY";

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

pub fn run(global: &GlobalFlags, store: &CredentialStore) -> Result<()> {
    let profile_name = global.resolved_profile();
    let identity = match resolve_identity(global, store)? {
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

/// Resolve the active credential source. Env vars win over the file. An API
/// key without a configured URL targets the zero-config local `serve`
/// endpoint for this auth probe; ordinary box commands still default to the
/// embedded runtime until a REST URL is configured.
fn resolve_identity(global: &GlobalFlags, store: &CredentialStore) -> Result<Option<Identity>> {
    let profile_name = global.resolved_profile();
    // Both `auth whoami` and the runtime in `cli.rs` skip the env path when
    // `BOXLITE_API_KEY` is set-but-empty (`!key.is_empty()`). `auth status`
    // used to short-circuit on a bare `is_ok()` check, so an empty value
    // would report "Logged in (env)" while every subsequent authenticated
    // command would actually fall back to the stored profile. Mirror the
    // canonical check here so `status` agrees with `whoami` / the runtime.
    if let Ok(api_key) = std::env::var(API_KEY_ENV)
        && !api_key.is_empty()
    {
        let stored_url = store.load_named(&profile_name)?.map(|profile| profile.url);
        let url = global
            .url
            .clone()
            .filter(|url| !url.is_empty())
            .or(stored_url)
            .unwrap_or_else(|| LOCAL_SERVE_URL.to_string());
        return Ok(Some(Identity {
            url,
            source: Source::EnvApiKey,
            method: None,
            expires_at: None,
        }));
    }

    let profile = store
        .load_named(&profile_name)
        .context("loading stored credentials")?;
    let Some(profile) = profile else {
        return Ok(None);
    };
    let path = store.path().context("resolving credentials path")?;
    Ok(Some(Identity {
        url: global
            .url
            .clone()
            .filter(|url| !url.is_empty())
            .unwrap_or(profile.url),
        source: Source::File {
            path_display: path.display().to_string(),
        },
        method: Some(profile.auth_method),
        expires_at: profile.expires_at,
    }))
}
