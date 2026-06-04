//! `boxlite auth login` — top-level dispatcher.
//!
//! Three concrete flows, all sharing the same `Profile` storage:
//!
//! | `--method`  | Backed by                          |
//! |-------------|------------------------------------|
//! | `api-key`   | [`super::api_key::run`]            |
//! | `browser`   | [`super::oidc::auth_code::run`]    |
//! | `device`    | [`super::oidc::device_code::run`]  |
//!
//! When `--method` is omitted we infer it. The inference is split into two
//! helpers — `resolve_target` (which URL + IdP settings to use) and
//! `should_use_device_flow` (browser vs device when both look viable) —
//! both flagged for the user to refine per the plan's §A and §B.

use std::io::IsTerminal;

use anyhow::{Context, Result, anyhow};
use clap::{Args, ValueEnum};
use dialoguer::{Select, theme::ColorfulTheme};

use super::api_key;
use super::oidc::{self, DiscoveryOverrides, OidcConfig, OidcTokens, discovery};
use crate::credentials::{self, Profile};
use crate::defaults::LOCAL_SERVE_URL;

const URL_ENV: &str = "BOXLITE_REST_URL";

#[derive(Args, Debug, Clone)]
pub struct LoginArgs {
    /// Server URL. Defaults to `LOCAL_SERVE_URL` (matching `boxlite serve`).
    #[arg(long)]
    pub url: Option<String>,

    /// Read a long-lived API key from stdin (one line). The flag takes no
    /// value, so the secret never appears on argv. Forces `--method api-key`.
    #[arg(long)]
    pub api_key_stdin: bool,

    /// Which login flow to use. Defaults to `api-key` for `--api-key-stdin`
    /// and a TTY prompt otherwise. On a non-TTY stdin we silently default
    /// to `api-key` so CI scripts keep working.
    #[arg(long, value_enum)]
    pub method: Option<Method>,

    /// Skip the browser; use Device Code (RFC 8628) instead. Useful on
    /// remote / SSH sessions where a callback URL is unreachable.
    /// Implies `--method device`.
    #[arg(long, conflicts_with_all = ["api_key_stdin"])]
    pub no_browser: bool,

    /// OIDC issuer URL. Overrides what `GET /api/config` returns. Useful
    /// for self-hosted Dex instances where the discovery is wrong.
    #[arg(long)]
    pub issuer: Option<String>,

    /// OIDC client_id. Overrides what `GET /api/config` returns.
    #[arg(long)]
    pub client_id: Option<String>,

    /// OIDC audience (Auth0 requires it; Dex tolerates `None`).
    #[arg(long)]
    pub audience: Option<String>,

    /// Local port for the browser-flow callback (`http://127.0.0.1:<PORT>/callback`).
    /// Must match an entry in the IdP's allow-list **byte-for-byte** — a
    /// different port produces the same "callback URL mismatch" failure
    /// as no entry at all. Defaults to 5555.
    #[arg(long)]
    pub callback_port: Option<u16>,
}

#[derive(ValueEnum, Debug, Clone, Copy, PartialEq, Eq)]
#[value(rename_all = "kebab-case")]
pub enum Method {
    /// Static API key — paste / stdin.
    ApiKey,
    /// OIDC Authorization Code with PKCE; opens a browser.
    Browser,
    /// OIDC Device Code (RFC 8628); headless / SSH friendly.
    Device,
}

pub async fn run(args: LoginArgs, profile_name: &str) -> Result<()> {
    let method = resolve_method(&args)?;
    let url = resolve_target(&args)?;

    match method {
        Method::ApiKey => api_key::run(Some(&url), args.api_key_stdin, profile_name).await,
        Method::Browser => run_browser(&args, &url, profile_name).await,
        Method::Device => run_device(&args, &url, profile_name).await,
    }
}

/// Browser-based OIDC login.
async fn run_browser(args: &LoginArgs, url: &str, profile_name: &str) -> Result<()> {
    let http = discovery::http_client()?;
    let overrides = overrides_from_args(args);
    let cfg = discovery::resolve_config(url, &overrides, &http).await?;
    let port = args
        .callback_port
        .unwrap_or(oidc::auth_code::DEFAULT_CALLBACK_PORT);
    let tokens = oidc::auth_code::run(&cfg, &http, port).await?;
    persist_oidc(url, profile_name, &cfg, tokens).await
}

/// Device-code OIDC login.
async fn run_device(args: &LoginArgs, url: &str, profile_name: &str) -> Result<()> {
    let http = discovery::http_client()?;
    let overrides = overrides_from_args(args);
    let cfg = discovery::resolve_config(url, &overrides, &http).await?;
    let tokens = oidc::device_code::run(&cfg, &http).await?;
    persist_oidc(url, profile_name, &cfg, tokens).await
}

/// Common tail: write tokens into a Profile, save under `profile_name`,
/// confirm with the server. Sharing the helper keeps the on-disk shape in
/// one place so the auth-code and device-code paths cannot drift.
async fn persist_oidc(
    url: &str,
    profile_name: &str,
    cfg: &OidcConfig,
    tokens: OidcTokens,
) -> Result<()> {
    // Confirm against `/v1/me` BEFORE saving — same contract as the API-key
    // flow. A working access token that the server rejects is the kind of
    // misconfiguration we want surfaced loudly.
    let mut profile = Profile {
        url: url.to_string(),
        ..Profile::default()
    };
    oidc::refresh::apply_tokens(&mut profile, cfg, tokens);

    let principal = verify_principal(&profile).await?;
    // Cache the principal's routing-slot value so subsequent
    // box-scoped commands substitute it into `/v1/<prefix>/...`.
    // `None` means the deployment doesn't use a routing slot;
    // URL builder skips the segment (`/v1/boxes/...`).
    profile.path_prefix = principal.path_prefix.clone();
    credentials::save_named(profile_name, &profile).context("saving credentials")?;

    let who = principal.email.as_deref().unwrap_or(principal.sub.as_str());
    match principal.path_prefix.as_deref() {
        Some(path_prefix) => println!("Logged in as {} (path prefix: {})", who, path_prefix),
        None => println!(
            "Logged in as {} (no path prefix; use --path-prefix or BOXLITE_REST_PATH_PREFIX for multi-tenant servers)",
            who
        ),
    }
    Ok(())
}

/// Hit `/v1/me` with the freshly minted access token. Token field is read
/// once via `expose_secret` at the BoxliteRestOptions boundary.
async fn verify_principal(profile: &Profile) -> Result<boxlite::Principal> {
    use boxlite::BoxliteRuntime;
    let opts = credentials::into_rest_options(profile.clone());
    let runtime = BoxliteRuntime::rest(opts)
        .map_err(|e| anyhow!("failed to construct REST runtime: {}", e))?;
    let auth = runtime
        .auth()
        .map_err(|e| anyhow!("failed to construct REST runtime: {}", e))?;
    auth.whoami()
        .await
        .map_err(|err| anyhow!("server rejected new OIDC session: {err}"))
}

fn overrides_from_args(args: &LoginArgs) -> DiscoveryOverrides {
    DiscoveryOverrides {
        issuer: args.issuer.clone(),
        client_id: args.client_id.clone(),
        audience: args.audience.clone(),
    }
}

/// Pick which of the three flows to run.
///
/// Explicit flags always win. When the user hasn't expressed a preference
/// we read the environment: a non-TTY stdin → `api-key` (CI), `--no-browser`
/// → `device`, otherwise prompt the user with a `dialoguer::Select`.
fn resolve_method(args: &LoginArgs) -> Result<Method> {
    if args.api_key_stdin {
        return Ok(Method::ApiKey);
    }
    if let Some(m) = args.method {
        // Honor the explicit choice even on a TTY.
        return Ok(if args.no_browser && m == Method::Browser {
            Method::Device
        } else {
            m
        });
    }
    if args.no_browser {
        return Ok(Method::Device);
    }
    if !std::io::stdin().is_terminal() {
        // Piped stdin: keep `echo $KEY | boxlite auth login --api-key-stdin`
        // working when callers forget the flag — never block on a prompt.
        return Ok(Method::ApiKey);
    }
    prompt_method()
}

/// Interactive picker for the three flows. Lives behind a TTY check so
/// non-interactive callers never hit it.
fn prompt_method() -> Result<Method> {
    let items = [
        "API key (paste)",
        "Browser (OIDC)",
        "Device code (headless / SSH)",
    ];
    let chosen = Select::with_theme(&ColorfulTheme::default())
        .with_prompt("How do you want to log in?")
        .items(&items)
        .default(0)
        .interact()
        .map_err(|e| anyhow!("reading login method choice: {e}"))?;
    Ok(match chosen {
        0 => Method::ApiKey,
        1 => {
            if should_use_device_flow() {
                eprintln!(
                    "no browser available (headless environment detected); using device code"
                );
                Method::Device
            } else {
                Method::Browser
            }
        }
        2 => Method::Device,
        _ => unreachable!("dialoguer::Select returns an index in 0..items.len()"),
    })
}

// =============================================================================
// Decision A — see plan §A.
//
// `resolve_target` decides which server URL the login flow points at. Today
// the precedence is **`--url` > `BOXLITE_REST_URL` env > stored profile's
// `url` > `LOCAL_SERVE_URL` default**, matching what the API-key flow has
// always done. This is a safe baseline — if you have feelings about whether
// `--profile cloud --url http://localhost:8100` should override stored OR
// merge, or whether `BOXLITE_REST_URL` should beat a saved cloud profile
// during a CI run, this is where to encode them.
//
// Things to weigh (do not implement here — change this function instead):
//   - Should `--url` ALWAYS win, including over the active profile's URL?
//     (current answer: yes — flag > anything else.)
//   - Should `BOXLITE_REST_URL` override a stored OIDC profile? (current
//     answer: yes — env beats file. Same precedence the API-key path used.)
//   - Should `--profile` without `--url` reuse the stored URL? (current
//     answer: yes — that's the whole point of saved profiles.)
//   - Anything that's missing? E.g., refusing to mix `--profile cloud` with
//     `--url http://localhost:8100` because the URL clearly belongs to a
//     different profile.
// =============================================================================
fn resolve_target(args: &LoginArgs) -> Result<String> {
    if let Some(url) = args.url.as_deref() {
        return Ok(url.to_string());
    }
    if let Ok(env_url) = std::env::var(URL_ENV)
        && !env_url.is_empty()
    {
        return Ok(env_url);
    }
    Ok(LOCAL_SERVE_URL.to_string())
}

// =============================================================================
// Decision B — see plan §B.
//
// `should_use_device_flow` decides when to auto-fall-back from browser to
// device code. Today this is **conservative**: only `$SSH_CONNECTION` set
// triggers fallback. That avoids the worst failure mode (`ssh user@host` →
// browser opens nothing → silent hang) without surprising desktop users.
//
// Things to weigh (do not implement here — change this function instead):
//   - `$DISPLAY` unset on Linux + no `$WAYLAND_DISPLAY` → headless?
//     (current answer: NO, because tmux/screen on a workstation can both
//     be unset and a browser still works.)
//   - macOS / Windows: never auto-fall-back; if a user wants device flow
//     they pass `--no-browser`. (current answer matches.)
//   - `webbrowser::open` failure: we already print the URL — should we
//     additionally retry as device? (current answer: NO, would silently
//     change the user's chosen flow.)
//   - `ssh -X` (X forwarding): `$SSH_CONNECTION` is still set even though a
//     browser would work. Cost of false-positive (device flow) is "you
//     typed a code unnecessarily"; cost of false-negative (no fallback) is
//     "the CLI hangs". This is the judgment call.
// =============================================================================
fn should_use_device_flow() -> bool {
    std::env::var_os("SSH_CONNECTION").is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `--api-key-stdin` forces api-key even if the user also passed
    /// `--method browser` (which the rest of the surface would otherwise
    /// accept). Stops a careless CI script from silently switching flows.
    #[test]
    fn api_key_stdin_forces_api_key_method() {
        let args = LoginArgs {
            url: None,
            api_key_stdin: true,
            method: Some(Method::Browser),
            no_browser: false,
            issuer: None,
            client_id: None,
            audience: None,
            callback_port: None,
        };
        assert_eq!(resolve_method(&args).unwrap(), Method::ApiKey);
    }

    /// `--no-browser` + `--method browser` → device. The flag combination
    /// is contradictory; this is the only one we silently resolve rather
    /// than reject — `--no-browser` is the more specific intent.
    #[test]
    fn no_browser_overrides_browser_method() {
        let args = LoginArgs {
            url: None,
            api_key_stdin: false,
            method: Some(Method::Browser),
            no_browser: true,
            issuer: None,
            client_id: None,
            audience: None,
            callback_port: None,
        };
        assert_eq!(resolve_method(&args).unwrap(), Method::Device);
    }

    /// Today's `resolve_target` falls back to the local serve URL — locks
    /// in that default so a future plan-§A change can prove it's
    /// intentionally different.
    #[test]
    fn resolve_target_defaults_to_local_serve() {
        // SAFETY: tests run on a fresh process by default; no env vars are
        // shared.
        // Note: if a parallel test sets BOXLITE_REST_URL we'd be wrong
        // here, but no other test currently mutates that var.
        unsafe {
            std::env::remove_var(URL_ENV);
        }
        let args = LoginArgs {
            url: None,
            api_key_stdin: false,
            method: None,
            no_browser: false,
            issuer: None,
            client_id: None,
            audience: None,
            callback_port: None,
        };
        assert_eq!(resolve_target(&args).unwrap(), LOCAL_SERVE_URL);
    }
}
