//! `boxlite auth login` — interactive or piped credential setup.
//!
//! Modes:
//! - `--api-key-stdin`               : single-line API key on stdin
//! - `--client-id ID --client-secret-stdin` : OAuth2 client_credentials pair
//! - no flags                        : interactive prompts (rpassword for secrets)
//!
//! After collecting a credential, we validate it by issuing a single
//! authenticated call against the server (`runtime.list_info()` → `GET /boxes`).
//! A `BoxliteError::Config("auth: ...")` from the client surfaces as a 401/403
//! and is reported as a credential error instead of being silently saved.

use std::io::{BufRead, Write};

use anyhow::{Context, Result, anyhow, bail};
use boxlite::BoxliteRuntime;
use clap::Args;

use crate::credentials::{self, Profile};

const DEFAULT_URL: &str = "https://dev.boxlite.ai/api";
const URL_ENV: &str = "BOXLITE_REST_URL";

#[derive(Args, Debug, Clone)]
pub struct LoginArgs {
    /// Server URL (default: https://dev.boxlite.ai/api).
    #[arg(long)]
    pub url: Option<String>,

    /// Read a long-lived API key from stdin (one line).
    #[arg(long, conflicts_with = "web")]
    pub api_key_stdin: bool,

    /// Open the browser and run the OAuth 2.0 device authorization flow
    /// (RFC 8628). Returned tokens are persisted to `~/.config/boxlite/credentials.toml`.
    #[arg(long)]
    pub web: bool,

    /// When combined with `--web`, do not launch a browser automatically;
    /// just print the activation URL. Useful for headless / SSH sessions.
    #[arg(long, requires = "web")]
    pub no_launch_browser: bool,
}

pub async fn run(args: LoginArgs) -> Result<()> {
    let non_interactive = args.api_key_stdin || args.web;
    let url = resolve_url(args.url.as_deref(), non_interactive)?;

    let profile = if args.web {
        let oauth = super::device::login(&url, args.no_launch_browser)
            .await
            .context("running browser device-flow login")?;
        Profile {
            url: url.clone(),
            api_key: None,
            oauth: Some(oauth),
        }
    } else if args.api_key_stdin {
        let api_key = read_stdin_line("API key")?;
        Profile {
            url: url.clone(),
            api_key: Some(api_key),
            oauth: None,
        }
    } else {
        prompt_profile(&url)?
    };

    validate(&profile).await?;
    credentials::save(&profile).context("saving credentials")?;

    let mode = credential_mode(&profile);
    println!("Logged in to {} {}", profile.url, mode);
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
        return Ok(DEFAULT_URL.to_string());
    }
    prompt_with_default("Server URL", DEFAULT_URL)
}

fn prompt_profile(url: &str) -> Result<Profile> {
    let url = prompt_with_default("Server URL", url)?;
    println!("Auth method:");
    println!("  1) API key");
    println!("  2) OAuth client credentials");
    let choice = prompt_with_default("Choose", "1")?;
    let trimmed = choice.trim();
    match trimmed {
        "1" | "" => {
            let key =
                rpassword::prompt_password("API key: ").context("reading API key from terminal")?;
            let key = key.trim().to_string();
            if key.is_empty() {
                bail!("API key cannot be empty");
            }
            Ok(Profile {
                url,
                api_key: Some(key),
                oauth: None,
            })
        }
        "2" => {
            bail!(
                "OAuth client_credentials grant is no longer supported. Use option 1 (API key) or `boxlite auth login --web` for browser device-flow login."
            );
        }
        other => bail!("invalid auth method choice: {:?}", other),
    }
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
///
/// We use `list_info()` (→ `GET /boxes`) because it is the cheapest
/// authenticated public API on `BoxliteRuntime`. The OAuth path triggers a
/// `/oauth/tokens` exchange on the first call; the Token path sends the bearer
/// directly. Either way, a 401/403 surfaces as
/// `BoxliteError::Config("auth: ...")` — we match on that to give a focused
/// "authentication failed" error rather than a generic HTTP one.
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

fn credential_mode(profile: &Profile) -> &'static str {
    if profile.api_key.is_some() {
        "(API key)"
    } else {
        "(OAuth client credentials)"
    }
}
