//! `boxlite auth whoami` — confirm the active credential's identity by
//! calling `GET /v1/me` and printing who you are.
//!
//! Unlike `auth status` (offline; only reports where the credential comes
//! from), `whoami` makes one authenticated request so it can show the
//! server-resolved identity, organization, and scopes.

use anyhow::{Context, Result, anyhow};
use boxlite::{BoxliteError, BoxliteRuntime};

use crate::credentials::{self, Profile};
use crate::defaults::LOCAL_SERVE_URL;

const API_KEY_ENV: &str = "BOXLITE_API_KEY";
const URL_ENV: &str = "BOXLITE_REST_URL";

pub async fn run() -> Result<()> {
    let Some(profile) = resolve_profile()? else {
        println!("Not logged in.");
        return Ok(());
    };
    // Keep the URL for messages — it is not secret (the api_key is, and we
    // never print that).
    let url = profile.url.clone();
    let runtime = BoxliteRuntime::rest(credentials::into_rest_options(profile))
        .map_err(|e| anyhow!("failed to construct REST runtime: {}", e))?;
    let auth = runtime
        .auth()
        .map_err(|e| anyhow!("failed to construct REST runtime: {}", e))?;

    match auth.whoami().await {
        Ok(p) => {
            let who = p.email.as_deref().unwrap_or(p.sub.as_str());
            println!("Logged in as:    {}", who);
            if let Some(name) = p.display_name.as_deref() {
                println!("Name:            {}", name);
            }
            println!("Principal:       {} ({})", p.sub, p.principal_type);
            println!("Organization:    {}", p.prefix);
            println!("Server:          {}", url);
            if !p.scopes.is_empty() {
                println!("Scopes:          {}", p.scopes.join(", "));
            }
            if let Some(exp) = p.expires_at.as_deref() {
                println!("Expires:         {}", exp);
            }
            Ok(())
        }
        Err(BoxliteError::NotFound(_)) => Err(anyhow!(
            "server at {} does not implement GET /v1/me — cannot show identity",
            url
        )),
        Err(err) => {
            let msg = err.to_string();
            if msg.contains("auth:") {
                Err(anyhow!("authentication failed against {}: {}", url, msg))
            } else {
                Err(anyhow!("could not reach {}: {}", url, msg))
            }
        }
    }
}

/// Active credential: `$BOXLITE_API_KEY` (+ `$BOXLITE_REST_URL`) wins over the
/// stored profile, matching the runtime precedence used elsewhere
/// (`GlobalFlags::create_runtime`, `auth status`).
fn resolve_profile() -> Result<Option<Profile>> {
    if let Ok(api_key) = std::env::var(API_KEY_ENV)
        && !api_key.is_empty()
    {
        let url = std::env::var(URL_ENV).unwrap_or_else(|_| LOCAL_SERVE_URL.to_string());
        return Ok(Some(Profile {
            url,
            api_key: Some(api_key),
        }));
    }
    credentials::load().context("loading stored credentials")
}
