//! RFC 8628 OAuth 2.0 Device Authorization Grant for `boxlite auth login --web`.
//!
//! Chosen over loopback-callback PKCE (RFC 8252 §7.3) because BoxLite users
//! run the CLI inside containers / SSH sessions / remote dev pods where
//! binding `127.0.0.1` for a callback fails. Vercel and Auth0 CLIs use the
//! same approach.
//!
//! Wire contract: `openapi/rest-sandbox-open-api.yaml` §`/v1/oauth/*` paths.

use std::io::{self, Write};
use std::time::{Duration, Instant, SystemTime};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use crate::credentials::OAuthCredentials;

const CLIENT_ID: &str = "boxlite-cli";
const DEFAULT_SCOPE: &str = "box:read box:write box:exec image:read image:write me:read";
const DEVICE_CODE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

#[derive(Debug, Serialize)]
struct DeviceCodeRequest<'a> {
    client_id: &'a str,
    scope: &'a str,
}

#[derive(Debug, Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    #[serde(default)]
    verification_uri_complete: Option<String>,
    expires_in: u64,
    #[serde(default = "default_interval")]
    interval: u64,
}

fn default_interval() -> u64 {
    5
}

#[derive(Debug, Serialize)]
struct TokenForm<'a> {
    grant_type: &'a str,
    device_code: &'a str,
    client_id: &'a str,
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    #[allow(dead_code)]
    token_type: Option<String>,
    expires_in: u64,
    refresh_token: String,
    #[serde(default)]
    #[allow(dead_code)]
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ErrorBody {
    error: String,
}

/// Run the device-flow login against `url`. On success, returns the
/// persistable OAuth credentials.
pub async fn login(url: &str, no_launch_browser: bool) -> Result<OAuthCredentials> {
    let client = reqwest::Client::new();
    let base = url.trim_end_matches('/');

    // Step 1: initiate device authorization.
    let device_url = format!("{base}/v1/oauth/device_code");
    let resp = client
        .post(&device_url)
        .form(&DeviceCodeRequest {
            client_id: CLIENT_ID,
            scope: DEFAULT_SCOPE,
        })
        .send()
        .await
        .with_context(|| format!("POST {device_url} (initiate device flow)"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        bail!("device authorization failed ({status}): {body}");
    }
    let dc: DeviceCodeResponse = resp.json().await.context("parsing device_code response")?;

    // Step 2: instruct the user.
    let activation_url = dc
        .verification_uri_complete
        .as_deref()
        .unwrap_or(&dc.verification_uri);
    println!();
    println!("To finish signing in:");
    println!("  Visit: {}", dc.verification_uri);
    println!("  Code:  {}", dc.user_code);
    if dc.verification_uri_complete.is_some() {
        println!("  (or open the one-click URL: {activation_url})");
    }
    println!();

    if !no_launch_browser {
        if webbrowser::open(activation_url).is_ok() {
            println!("Browser opened. Complete the flow there, then return here.");
        } else {
            println!("Could not auto-open a browser. Open the URL above manually.");
        }
    }

    // Step 3: poll the token endpoint.
    let token_url = format!("{base}/v1/oauth/token");
    let mut interval = Duration::from_secs(dc.interval.max(1));
    let deadline = Instant::now() + Duration::from_secs(dc.expires_in);

    print!("Waiting for browser authorization");
    io::stdout().flush().ok();

    loop {
        if Instant::now() >= deadline {
            println!();
            bail!("device code expired before the user authorized");
        }
        tokio::time::sleep(interval).await;

        let resp = client
            .post(&token_url)
            .form(&TokenForm {
                grant_type: DEVICE_CODE_GRANT,
                device_code: &dc.device_code,
                client_id: CLIENT_ID,
            })
            .send()
            .await
            .with_context(|| format!("POST {token_url} (poll)"))?;

        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();

        if status.is_success() {
            println!(" ✓");
            let token: TokenResponse =
                serde_json::from_str(&body).context("parsing token response")?;
            let expires_at = SystemTime::now() + Duration::from_secs(token.expires_in);
            return Ok(OAuthCredentials::from_sdk(&boxlite::OAuthTokens {
                access_token: token.access_token,
                refresh_token: token.refresh_token,
                expires_at,
            }));
        }

        // RFC 6749 §5.2 / RFC 8628 §3.5 — error JSON drives polling behavior.
        let err: ErrorBody = serde_json::from_str(&body).unwrap_or(ErrorBody {
            error: "unknown_error".into(),
        });
        match err.error.as_str() {
            "authorization_pending" => {
                print!(".");
                io::stdout().flush().ok();
            }
            "slow_down" => {
                interval += Duration::from_secs(5);
                print!(".");
                io::stdout().flush().ok();
            }
            "expired_token" => {
                println!();
                bail!("device code expired; run `boxlite auth login --web` again");
            }
            "access_denied" => {
                println!();
                bail!("authorization denied in browser");
            }
            other => {
                println!();
                bail!("token endpoint returned error: {other} (HTTP {status}): {body}");
            }
        }
    }
}
