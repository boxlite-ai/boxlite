//! `boxlite auth login` — interactive or piped API-key setup.
//!
//! Modes:
//! - `--api-key-stdin` : single-line API key on stdin (CI-friendly; no argv leak)
//! - no flags          : interactive `rpassword` prompt
//!
//! After collecting a key we validate it via `GET /v1/me` and, on success,
//! print *who* the credential authenticates as. A 401/403 surfaces as
//! `BoxliteError::Config("auth: ...")` and is reported as a credential error
//! rather than being silently saved. Servers without `/v1/me` return 404
//! (`BoxliteError::NotFound`) — we fall back to `runtime.list_info()`
//! (`GET /boxes`) so older servers still validate (zero regression).

use std::io::{BufRead, Write};

use anyhow::{Context, Result, anyhow, bail};
use boxlite::{BoxliteError, BoxliteRuntime, Principal};
use clap::Args;

use crate::credentials::{self, Profile};
use crate::defaults::LOCAL_SERVE_URL;

const URL_ENV: &str = "BOXLITE_REST_URL";

#[derive(Args, Debug, Clone)]
pub struct LoginArgs {
    /// Server URL. Defaults to `LOCAL_SERVE_URL` (matching `boxlite serve`).
    #[arg(long)]
    pub url: Option<String>,

    /// Read a long-lived API key from stdin (one line). The flag takes no
    /// value, so the secret never appears on argv.
    #[arg(long)]
    pub api_key_stdin: bool,
}

pub async fn run(args: LoginArgs) -> Result<()> {
    let url = resolve_url(args.url.as_deref(), args.api_key_stdin)?;

    let api_key = if args.api_key_stdin {
        read_stdin_line("API key")?
    } else {
        prompt_api_key()?
    };

    let profile = Profile {
        url: url.clone(),
        api_key: Some(api_key),
    };

    let identity = validate(&profile).await?;
    credentials::save(&profile).context("saving credentials")?;

    // Don't log profile.url — CodeQL flags the success line as cleartext
    // logging of sensitive info (the profile carries the api_key). Mirrors
    // the upstream autofix in a6184a92. The server-returned identity
    // (email/sub/prefix) is not secret and is safe to print.
    match identity {
        Some(p) => {
            let who = p.email.as_deref().unwrap_or(p.sub.as_str());
            println!("Logged in as {} (org: {})", who, p.prefix);
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

/// Turn a client error into a focused, non-secret message. 401/403 map to
/// `BoxliteError::Config("auth: …")`; everything else is treated as a
/// connectivity/server error. Credentials are not saved in either case.
fn classify(profile: &Profile, err: BoxliteError) -> anyhow::Error {
    let msg = err.to_string();
    if msg.contains("auth:") {
        anyhow!(
            "authentication failed against {}: {} (credentials not saved)",
            profile.url,
            msg
        )
    } else {
        anyhow!(
            "could not reach {}: {} (credentials not saved)",
            profile.url,
            msg
        )
    }
}
