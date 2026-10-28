//! API-key login: collect a long-lived key (paste or stdin), validate it
//! against the server's `/v1/me`, and persist it under `profile_name`.

use std::io::BufRead;

use anyhow::{Context, Result, anyhow, bail};
use boxlite::{BoxliteError, BoxliteRuntime, Principal};
use secrecy::SecretString;

use crate::credentials::{self, CredentialStore, Profile};

/// Run the API-key flow.
///
/// - `url`: server URL resolved by the login dispatcher.
/// - `api_key_stdin`: when `true`, read the key from stdin (single line).
///   When `false`, prompt with `rpassword` for an interactive paste.
/// - `profile_name`: which profile in `<BOXLITE_HOME>/credentials.toml` to write.
pub async fn run(
    url: &str,
    api_key_stdin: bool,
    profile_name: &str,
    store: &CredentialStore,
) -> Result<()> {
    let api_key = if api_key_stdin {
        read_stdin_line("API key")?
    } else {
        prompt_api_key()?
    };

    let mut profile = Profile {
        url: url.to_string(),
        api_key: Some(SecretString::from(api_key)),
        ..Profile::default()
    };

    let identity = validate(&profile).await?;
    // Cache the principal's routing-slot value so subsequent
    // box-scoped commands substitute it into `/v1/<prefix>/...`.
    // `None` means the deployment doesn't use a routing slot; the
    // URL builder skips the segment (`/v1/boxes/...`).
    if let Some(p) = identity.as_ref() {
        profile.path_prefix = p.path_prefix.clone();
    }
    store
        .save_named(profile_name, &profile)
        .context("saving credentials")?;

    // Don't log profile.url — CodeQL flags the success line as cleartext
    // logging of sensitive info (the profile carries the api_key). The
    // server-returned identity (email/sub/path_prefix) is not secret
    // and is safe to print.
    match identity {
        Some(p) => {
            let who = p.email.as_deref().unwrap_or(p.sub.as_str());
            match p.path_prefix.as_deref() {
                Some(path_prefix) => {
                    println!("Logged in as {} (path prefix: {})", who, path_prefix)
                }
                None => println!("Logged in as {} (the server returned no path prefix)", who),
            }
        }
        None => println!("Logged in (API key)"),
    }
    Ok(())
}

fn prompt_api_key() -> Result<String> {
    let key = rpassword::prompt_password("API key: ").context("reading API key from terminal")?;
    let key = key.trim().to_string();
    if key.is_empty() {
        bail!("API key cannot be empty");
    }
    Ok(key)
}

/// Read exactly one line from stdin, trim trailing newline, error on empty.
/// Used by `--api-key-stdin` so the secret never appears on argv.
fn read_stdin_line(label: &str) -> Result<String> {
    let mut buf = String::new();
    let n = std::io::stdin()
        .lock()
        .read_line(&mut buf)
        .with_context(|| format!("reading {} from stdin", label))?;
    if n == 0 {
        bail!("{} not provided on stdin", label);
    }
    let trimmed = buf.trim_end_matches(['\n', '\r']).to_string();
    if trimmed.is_empty() {
        bail!("{} is empty", label);
    }
    Ok(trimmed)
}

/// Confirm the credential against the server. Prefers `GET /v1/me` so we can
/// report the identity; on a server without that endpoint (404 →
/// `BoxliteError::NotFound`) falls back to `runtime.list_info()`
/// (`GET /boxes`) — the cheapest authenticated call — so older servers still
/// validate. Returns `Some(principal)` when identified, `None` when validated
/// via the fallback. A 401/403 (`BoxliteError::Config("auth: …")`) or any
/// other error is reported and the credential is NOT saved.
async fn validate(profile: &Profile) -> Result<Option<Principal>> {
    let opts = credentials::into_rest_options(profile.clone());
    let runtime = BoxliteRuntime::rest(opts)
        .map_err(|e| anyhow!("failed to construct REST runtime: {}", e))?;
    let auth = runtime
        .auth()
        .map_err(|e| anyhow!("failed to construct REST runtime: {}", e))?;
    match auth.whoami().await {
        Ok(principal) => Ok(Some(principal)),
        // Server without `/v1/me` (404) → fall back to the cheapest
        // authenticated call so older servers still validate (zero
        // regression). `list_info` (`GET /boxes`) is a legitimate
        // box-runtime operation; it reuses the *same* `runtime` — identity
        // and box ops are two capability views of one REST client.
        Err(BoxliteError::NotFound(_)) => match runtime.list_info().await {
            Ok(_) => Ok(None),
            Err(err) => Err(classify(profile, err)),
        },
        Err(err) => Err(classify(profile, err)),
    }
}

/// Turn a client error into a focused, non-secret message.
///
/// Three buckets: an auth rejection from the server (`Config("auth: …")`
/// — produced by the 401/403 arms of the status table in `rest::error`), a
/// network-class failure (`Network(_)` — a transport error, a bare 5xx from
/// an intermediary, or a `network_unavailable` the server named itself),
/// and everything else.
/// We never persist credentials in any of the failure cases.
fn classify(profile: &Profile, err: BoxliteError) -> anyhow::Error {
    match err {
        BoxliteError::Config(ref msg) if msg.starts_with("auth:") => anyhow!(
            "authentication failed against {}: {} (credentials not saved)",
            profile.url,
            msg
        ),
        ref e @ BoxliteError::Network(_) => anyhow!(
            "could not reach {}: {} (credentials not saved). \
             Check that the server is running, the URL is correct, \
             and any HTTP_PROXY env vars don't shadow this destination.",
            profile.url,
            e
        ),
        other => anyhow!(
            "could not reach {}: {} (credentials not saved)",
            profile.url,
            other
        ),
    }
}
