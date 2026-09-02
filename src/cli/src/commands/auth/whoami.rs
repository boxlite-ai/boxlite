//! `boxlite auth whoami` — confirm the active credential's identity by
//! calling `GET /v1/me` and printing who you are.
//!
//! Unlike `auth status` (offline; only reports where the credential comes
//! from), `whoami` makes one authenticated request so it can show the
//! server-resolved identity, organization, and scopes.

use anyhow::{Context, Result, anyhow};
use boxlite::{BoxliteError, BoxliteRestOptions, BoxliteRuntime};
use secrecy::SecretString;

use crate::cli::GlobalFlags;
use crate::commands::auth::oidc::discovery;
use crate::credentials::{CredentialStore, Profile};
use crate::defaults::LOCAL_SERVE_URL;

const API_KEY_ENV: &str = "BOXLITE_API_KEY";

pub async fn run(global: &GlobalFlags, store: &CredentialStore) -> Result<()> {
    let profile_name = global.resolved_profile();
    let Some(opts) = resolve_options(global, store).await? else {
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
        Err(BoxliteError::Config(msg)) if msg.starts_with("auth:") => {
            Err(anyhow!("authentication failed against {}: {}", url, msg))
        }
        Err(err @ BoxliteError::Network(_)) => Err(anyhow!(
            "could not reach {}: {}. Check the URL, that the server is \
             running, and any HTTP_PROXY env vars.",
            url,
            err
        )),
        Err(err) => Err(anyhow!("could not reach {}: {}", url, err)),
    }
}

/// Active credential, ready to attach to a REST runtime.
///
/// `$BOXLITE_API_KEY` (+ `$BOXLITE_REST_URL`) wins over the stored profile.
/// An API key without a URL targets the zero-config local `serve` endpoint
/// for this auth probe; ordinary box commands still default to the embedded
/// runtime. The env path returns fresh `BoxliteRestOptions`; the file path goes through
/// [`CredentialStore::load_active`], which is also where OIDC tokens get
/// refreshed when they are about to expire.
async fn resolve_options(
    global: &GlobalFlags,
    store: &CredentialStore,
) -> Result<Option<BoxliteRestOptions>> {
    let profile_name = global.resolved_profile();
    if let Ok(api_key) = std::env::var(API_KEY_ENV)
        && !api_key.is_empty()
    {
        let stored = store.load_named(&profile_name)?;
        if let Some(options) = global.resolve_rest_options(stored, Some(api_key.clone())) {
            return Ok(Some(options));
        }
        let profile = Profile {
            url: LOCAL_SERVE_URL.to_string(),
            api_key: Some(SecretString::from(api_key)),
            ..Profile::default()
        };
        return Ok(Some(crate::credentials::into_rest_options(profile)));
    }
    let http = discovery::http_client()?;
    let mut options = store
        .load_active(&profile_name, &http)
        .await
        .context("loading stored credentials")?;
    if let Some(options) = options.as_mut()
        && let Some(url) = global.url.as_ref().filter(|url| !url.is_empty())
    {
        options.url = url.clone();
    }
    Ok(options)
}
