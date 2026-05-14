//! `boxlite auth status` — show where credentials come from without revealing
//! secret material.

use anyhow::{Context, Result};

use crate::credentials;

const API_KEY_ENV: &str = "BOXLITE_API_KEY";
const URL_ENV: &str = "BOXLITE_REST_URL";
const DEFAULT_URL: &str = "https://dev.boxlite.ai/api";

enum CredentialKind {
    ApiKey,
    OAuth { expires_at: String },
}

enum Source {
    /// `BOXLITE_API_KEY` set in the environment.
    EnvApiKey,
    /// On-disk file. `path_display` is the resolved location.
    File { path_display: String },
}

struct Identity {
    url: String,
    kind: CredentialKind,
    source: Source,
}

pub fn run() -> Result<()> {
    let identity = match resolve_identity()? {
        Some(id) => id,
        None => {
            println!("Not logged in.");
            return Ok(());
        }
    };

    let credential_label = match &identity.kind {
        CredentialKind::ApiKey => "API key".to_string(),
        CredentialKind::OAuth { expires_at } => {
            format!("OAuth (access_token expires {expires_at})")
        }
    };
    let source_label = match identity.source {
        Source::EnvApiKey => format!("{} env var", API_KEY_ENV),
        Source::File { path_display } => path_display,
    };

    println!("Logged in to:    {}", identity.url);
    println!(
        "Credential:      {} (from {})",
        credential_label, source_label
    );
    Ok(())
}

/// Resolve the active credential source. Env vars win over the file (matches
/// the runtime precedence used by `from_env()`).
fn resolve_identity() -> Result<Option<Identity>> {
    if let Ok(_key) = std::env::var(API_KEY_ENV) {
        let url = std::env::var(URL_ENV).unwrap_or_else(|_| DEFAULT_URL.to_string());
        return Ok(Some(Identity {
            url,
            kind: CredentialKind::ApiKey,
            source: Source::EnvApiKey,
        }));
    }

    let profile = credentials::load().context("loading stored credentials")?;
    let Some(profile) = profile else {
        return Ok(None);
    };
    let path = credentials::path().context("resolving credentials path")?;
    let path_display = path.display().to_string();
    let kind = if let Some(oauth) = profile.oauth.as_ref() {
        CredentialKind::OAuth {
            expires_at: oauth.expires_at.clone(),
        }
    } else {
        CredentialKind::ApiKey
    };
    Ok(Some(Identity {
        url: profile.url,
        kind,
        source: Source::File { path_display },
    }))
}
