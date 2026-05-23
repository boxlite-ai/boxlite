//! `boxlite auth whoami` — confirm the active credential's identity by
//! calling `GET /v1/me` and printing who you are.
//!
//! Unlike `auth status` (offline; only reports where the credential comes
//! from), `whoami` makes one authenticated request so it can show the
//! server-resolved identity, organization, and scopes.

use anyhow::{Context, Result, anyhow};
use boxlite::{BoxliteError, BoxliteRestOptions, BoxliteRuntime};
use secrecy::SecretString;

use crate::commands::auth::oidc::discovery;
use crate::credentials::{self, Profile};
use crate::defaults::LOCAL_SERVE_URL;

const API_KEY_ENV: &str = "BOXLITE_API_KEY";
const URL_ENV: &str = "BOXLITE_REST_URL";

pub async fn run(profile_name: &str) -> Result<()> {
    let Some(opts) = resolve_options(profile_name).await? else {
        println!("Not logged in (profile `{}`).", profile_name);
        return Ok(());
    };
    let url = opts.url.clone();
    let runtime = BoxliteRuntime::rest(opts)
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
            if let Some(path_prefix) = p.path_prefix.as_deref() {
                println!("Path prefix:     {}", path_prefix);
            }
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

/// Active credential, ready to attach to a REST runtime.
///
/// `$BOXLITE_API_KEY` (+ `$BOXLITE_REST_URL`) wins over the stored profile,
/// matching the runtime precedence used elsewhere
/// (`GlobalFlags::create_runtime`, `auth status`). The env path returns a
/// fresh `BoxliteRestOptions` directly; the file path goes through
/// [`credentials::load_active`], which is also where OIDC tokens get
/// refreshed when they are about to expire.
async fn resolve_options(profile_name: &str) -> Result<Option<BoxliteRestOptions>> {
    if let Ok(api_key) = std::env::var(API_KEY_ENV)
        && !api_key.is_empty()
    {
        let url = std::env::var(URL_ENV).unwrap_or_else(|_| LOCAL_SERVE_URL.to_string());
        let profile = Profile {
            url,
            api_key: Some(SecretString::from(api_key)),
            ..Profile::default()
        };
        return Ok(Some(credentials::into_rest_options(profile)));
    }
    let http = discovery::http_client()?;
    credentials::load_active(profile_name, &http)
        .await
        .context("loading stored credentials")
}
