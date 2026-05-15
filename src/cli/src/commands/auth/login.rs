//! `boxlite auth login` — interactive or piped API-key setup.
//!
//! Modes:
//! - `--api-key-stdin` : single-line API key on stdin (CI-friendly; no argv leak)
//! - no flags          : interactive `rpassword` prompt
//!
//! After collecting a key we validate it by issuing one authenticated call
//! against the server (`runtime.list_info()` → `GET /boxes`). A
//! `BoxliteError::Config("auth: ...")` from the client surfaces as 401/403
//! and is reported as a credential error rather than being silently saved.

use std::io::{BufRead, Write};

use anyhow::{Context, Result, anyhow, bail};
use boxlite::BoxliteRuntime;
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

    validate(&profile).await?;
    credentials::save(&profile).context("saving credentials")?;

    // Don't log profile.url — CodeQL flags the success line as
    // cleartext logging of sensitive info (the profile carries the
    // api_key). Mirrors the upstream autofix in a6184a92.
    println!("Logged in (API key)");
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

/// Issue one authenticated request to confirm the credential is accepted.
/// `list_info()` (→ `GET /boxes`) is the cheapest authenticated public API.
/// A 401/403 surfaces as `BoxliteError::Config("auth: ...")` — we match on
/// that string to give a focused error rather than a generic HTTP one.
async fn validate(profile: &Profile) -> Result<()> {
    let opts = credentials::into_rest_options(profile.clone());
    let runtime = BoxliteRuntime::rest(opts)
        .map_err(|e| anyhow!("failed to construct REST runtime: {}", e))?;
    match runtime.list_info().await {
        Ok(_) => Ok(()),
        Err(err) => {
            let msg = err.to_string();
            if msg.contains("auth:") {
                Err(anyhow!(
                    "authentication failed against {}: {}",
                    profile.url,
                    msg
                ))
            } else {
                Err(anyhow!(
                    "could not reach {}: {} (credentials not saved)",
                    profile.url,
                    msg
                ))
            }
        }
    }
}
