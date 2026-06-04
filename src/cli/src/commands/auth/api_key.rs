//! API-key login: collect a long-lived key (paste or stdin), validate it
//! against the server's `/v1/me`, and persist it under `profile_name`.
//!
//! This is the original `boxlite auth login` behavior — preserved unchanged
//! so anyone who only uses `--api-key-stdin` in CI is not affected by the
//! OIDC work.

use std::io::{BufRead, Write};

use anyhow::{Context, Result, anyhow, bail};
use boxlite::{BoxliteError, BoxliteRuntime, Principal};
use secrecy::SecretString;

use crate::credentials::{self, Profile};
use crate::defaults::LOCAL_SERVE_URL;

const URL_ENV: &str = "BOXLITE_REST_URL";

/// Run the API-key flow.
///
/// - `url_flag`: explicit `--url`, if any.
/// - `api_key_stdin`: when `true`, read the key from stdin (single line).
///   When `false`, prompt with `rpassword` for an interactive paste.
/// - `profile_name`: which profile in `~/.boxlite/credentials.toml` to write.
pub async fn run(url_flag: Option<&str>, api_key_stdin: bool, profile_name: &str) -> Result<()> {
    let url = resolve_url(url_flag, api_key_stdin)?;

    let api_key = if api_key_stdin {
        read_stdin_line("API key")?
    } else {
        prompt_api_key()?
    };

    let mut profile = Profile {
        url: url.clone(),
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
    credentials::save_named(profile_name, &profile).context("saving credentials")?;

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
                None => println!(
                    "Logged in as {} (no path prefix; use --path-prefix or BOXLITE_REST_PATH_PREFIX for multi-tenant servers)",
                    who
                ),
            }
        }
        None => println!("Logged in (API key)"),
    }
    Ok(())
}

/// Resolve the effective server URL.
///
/// Precedence: explicit `--url` > `$BOXLITE_REST_URL` > (interactive: prompt
/// with default) or (non-interactive: silently fall back to default). The
/// non-interactive default keeps piped one-liners (`echo $KEY | boxlite auth
/// login --api-key-stdin`) ergonomic without forcing `--url`.
fn resolve_url(flag: Option<&str>, non_interactive: bool) -> Result<String> {
    if let Some(url) = flag {
        return Ok(url.to_string());
    }
    if let Ok(env_url) = std::env::var(URL_ENV)
        && !env_url.is_empty()
    {
        return Ok(env_url);
    }
    if non_interactive {
        return Ok(LOCAL_SERVE_URL.to_string());
    }
    prompt_with_default("Server URL", LOCAL_SERVE_URL)
}

fn prompt_api_key() -> Result<String> {
    let key = rpassword::prompt_password("API key: ").context("reading API key from terminal")?;
    let key = key.trim().to_string();
    if key.is_empty() {
        bail!("API key cannot be empty");
    }
    Ok(key)
}

fn prompt_with_default(label: &str, default: &str) -> Result<String> {
    print!("{} [{}]: ", label, default);
    std::io::stdout().flush().ok();
    let mut buf = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut buf)
        .with_context(|| format!("reading {} from stdin", label))?;
    let value = buf.trim();
    if value.is_empty() {
        Ok(default.to_string())
    } else {
        Ok(value.to_string())
    }
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
/// — produced by `map_http_error` for 401/403), a transport-level
/// failure that never reached the server (`Network(_)` — including the
/// "bare 5xx → proxy" path in `map_http_status`), and everything else.
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
