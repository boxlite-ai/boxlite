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
use crate::defaults::DEFAULT_REST_URL;

const API_KEY_ENV: &str = "BOXLITE_API_KEY";

pub async fn run(global: &GlobalFlags, store: &CredentialStore) -> Result<()> {
    let profile_name = global.resolved_context();
    let Some(opts) = resolve_options(global, store).await? else {
        println!("Not logged in (context `{}`).", profile_name);
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
/// An API key without a URL targets the hosted API
/// for this auth probe; ordinary box commands still default to the embedded
/// runtime. The env path returns fresh `BoxliteRestOptions`; the file path goes through
/// [`CredentialStore::load_active`], which is also where OIDC tokens get
/// refreshed when they are about to expire.
async fn resolve_options(
    global: &GlobalFlags,
    store: &CredentialStore,
) -> Result<Option<BoxliteRestOptions>> {
    let profile_name = global.resolved_context();
    if let Ok(api_key) = std::env::var(API_KEY_ENV)
        && !api_key.is_empty()
    {
        let stored = store.load_named(&profile_name)?;
        if let Some(options) = global.resolve_rest_options(stored, Some(api_key.clone())) {
            return Ok(Some(options));
        }
        let profile = Profile {
            url: DEFAULT_REST_URL.to_string(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// An environment API key supplies the bearer token for the hosted fallback.
    #[tokio::test]
    async fn env_api_key_defaults_to_hosted_api_without_a_profile() {
        let home = TempDir::new().unwrap();
        let store = CredentialStore::new(Some(home.path().to_path_buf()));
        let global = GlobalFlags {
            debug: false,
            home: None,
            registry: vec![],
            config: None,
            url: None,
            profile: None,
            context_source: None,
            selected_context: None,
            path_prefix: None,
            experimental_features: Default::default(),
        };

        // SAFETY: nextest isolates tests in processes; the Cargo fallback runs
        // CLI unit tests with --test-threads=1.
        unsafe { std::env::set_var(API_KEY_ENV, "env-test-key") };
        let options = resolve_options(&global, &store).await;
        unsafe { std::env::remove_var(API_KEY_ENV) };

        let options = options.unwrap().expect("REST options for the API key");
        assert_eq!(options.url, "https://api.boxlite.ai");
        let token = options.credential.unwrap().get_token().await.unwrap();
        assert_eq!(token.token, "env-test-key");
    }
}
