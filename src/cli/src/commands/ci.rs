use anyhow::{Context, bail};
use boxlite::BoxliteRestOptions;
use clap::{Args, Subcommand};
use reqwest::{Client, Method};
use serde_json::{Value, json};
use std::time::{Duration, Instant};
use url::Url;

use crate::cli::GlobalFlags;

#[derive(Args, Debug)]
pub struct CiArgs {
    #[command(subcommand)]
    command: CiCommand,
}

#[derive(Subcommand, Debug)]
enum CiCommand {
    /// Bind a GitHub App installation to the selected BoxLite organization.
    Connect(ConnectArgs),
}

#[derive(Args, Debug)]
struct ConnectArgs {
    /// GitHub personal account or organization owning the installation.
    github_account: String,
    /// Permit CI from private repositories in this installation.
    #[arg(long)]
    allow_private_repositories: bool,
    /// Print the GitHub authorization URL without opening a browser.
    #[arg(long)]
    no_browser: bool,
}

pub async fn execute(args: CiArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let CiCommand::Connect(args) = args.command;
    // Match the Connect API's bounded account-name input before issuing HTTP.
    if args.github_account.is_empty()
        || args.github_account.len() > 39
        || !args.github_account.as_bytes()[0].is_ascii_alphanumeric()
        || !args
            .github_account
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        bail!("GitHub account must be an account or organization name");
    }
    let options = global
        .selected_rest_options()?
        .context("CI connect requires a remote context; run boxlite auth login first")?;
    let endpoint = endpoint(&options)?;
    // Allow authorization work to settle while bounding each CLI HTTP request.
    let http = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(75))
        .build()?;
    eprintln!(
        "Connecting {}: current and future App-selected repositories will use this BoxLite organization.",
        args.github_account
    );
    eprintln!(
        "Private repositories: {}.",
        if args.allow_private_repositories {
            "allowed"
        } else {
            "disabled"
        }
    );
    let started = request(
        &http,
        &options,
        Method::POST,
        endpoint.clone(),
        Some(json!({
            "github_account": args.github_account,
            "follow_installation": true,
            "allow_private_repositories": args.allow_private_repositories,
        })),
    )
    .await?;
    let id = field(&started, "id")?;
    if id.len() != 36 || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-') {
        bail!("Invalid connect transaction ID");
    }
    let verification = field(&started, "verification_uri")?;
    if verification != "https://github.com/login/device" {
        bail!("Unexpected GitHub verification URL");
    }
    eprintln!(
        "Open {verification} and enter code {}",
        field(&started, "user_code")?
    );
    if !args.no_browser && webbrowser::open(verification).is_err() {
        eprintln!("Browser unavailable; open the URL above manually.");
    }
    let response = wait_for_connection(&http, &options, &started, async {
        let _ = tokio::signal::ctrl_c().await;
    })
    .await?;
    let listener = field(&response, "listener_status")?;
    println!("Connected {}. Listener: {listener}.", args.github_account);
    println!("runs-on: boxlite");
    if listener != "ready" {
        println!("Binding saved; CI capacity is not ready yet.");
    }
    Ok(())
}

async fn wait_for_connection(
    http: &Client,
    options: &BoxliteRestOptions,
    started: &Value,
    interrupt: impl std::future::Future<Output = ()>,
) -> anyhow::Result<Value> {
    let base = endpoint(options)?;
    let id = field(started, "id")?;
    let poll_url = Url::parse(&format!("{base}/{id}/poll"))?;
    let cancel_url = Url::parse(&format!("{base}/{id}"))?;
    let mut interval = started
        .get("interval")
        .and_then(Value::as_u64)
        .unwrap_or(5)
        .clamp(1, 60);
    let expires = chrono::DateTime::parse_from_rfc3339(field(started, "expires_at")?)
        .context("Invalid connect expiry")?;
    let remaining = (expires.with_timezone(&chrono::Utc) - chrono::Utc::now())
        .to_std()
        .unwrap_or_default();
    // Cap one interactive authorization session at fifteen minutes, even if the server asks for longer.
    let deadline = Instant::now() + remaining.min(Duration::from_secs(900));
    tokio::pin!(interrupt);
    loop {
        let next = async {
            tokio::time::sleep(Duration::from_secs(interval)).await;
            request(http, options, Method::POST, poll_url.clone(), None).await
        };
        let response = tokio::select! {
            response = next => response?,
            _ = &mut interrupt => return Err(cancel_attempt(http, options, cancel_url, "cancelled").await),
            _ = tokio::time::sleep_until(deadline.into()) => return Err(cancel_attempt(http, options, cancel_url, "timed out").await),
        };
        match field(&response, "status")? {
            "connected" => return Ok(response),
            "pending" => {
                // A server-requested interval cannot exceed the entire session's fifteen-minute cap.
                interval = response
                    .get("interval")
                    .and_then(Value::as_u64)
                    .unwrap_or(interval)
                    .clamp(1, 900)
            }
            "installation_required" => {
                let install = Url::parse(field(&response, "installation_url")?)?;
                if install.scheme() != "https" || install.host_str() != Some("github.com") {
                    bail!("Invalid App installation URL");
                }
                eprintln!("Install the App at {install}");
                bail!("Complete installation, then run connect again for a new authorization");
            }
            "failed" | "expired" | "cancelled" => bail!(
                "GitHub authorization was denied, expired, interrupted, or conflicts with an existing binding; run connect again"
            ),
            _ => bail!("Unknown connect state"),
        }
    }
}

async fn cancel_attempt(
    http: &Client,
    options: &BoxliteRestOptions,
    url: Url,
    reason: &str,
) -> anyhow::Error {
    // Ctrl-C and expiry get a bounded five-second best-effort cancellation.
    match tokio::time::timeout(
        Duration::from_secs(5),
        request(http, options, Method::DELETE, url, None),
    )
    .await
    {
        Ok(Ok(response)) if response.get("status").and_then(Value::as_str) == Some("connected") => {
            anyhow::anyhow!(
                "CI connect {reason}, but binding already completed and remains connected"
            )
        }
        Ok(Ok(response))
            if matches!(
                response.get("status").and_then(Value::as_str),
                Some("cancelled" | "expired" | "failed")
            ) =>
        {
            anyhow::anyhow!("CI connect {reason}; pending authorization cancelled")
        }
        _ => anyhow::anyhow!("CI connect {reason}; cancellation could not be confirmed"),
    }
}

fn endpoint(options: &BoxliteRestOptions) -> anyhow::Result<Url> {
    let mut base = Url::parse(&options.url).context("Invalid context URL")?;
    let local = matches!(base.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    if (base.scheme() != "https" && !(base.scheme() == "http" && local))
        || !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        bail!("CI connect requires HTTPS (or HTTP loopback) without URL credentials or query");
    }
    let path = base.path().trim_end_matches('/').to_owned();
    base.set_path(&path);
    {
        let mut segments = base
            .path_segments_mut()
            .map_err(|_| anyhow::anyhow!("Invalid context URL"))?;
        segments.pop_if_empty();
        if !path.ends_with("/v1") {
            segments.push("v1");
        }
        if let Some(prefix) = options.path_prefix.as_deref().filter(|p| !p.is_empty()) {
            for part in prefix.split('/') {
                if part.is_empty() || part == "." || part == ".." {
                    bail!("Invalid context path prefix");
                }
                segments.push(part);
            }
        }
        segments.push("ci").push("connect");
    }
    Ok(base)
}

async fn request(
    http: &Client,
    options: &BoxliteRestOptions,
    method: Method,
    url: Url,
    body: Option<Value>,
) -> anyhow::Result<Value> {
    let credential = options
        .credential
        .as_ref()
        .context("CI connect requires authentication")?;
    let token = credential
        .get_token()
        .await
        .context("Loading context credential")?;
    let bodiless_post = body.is_none() && method == Method::POST;
    let mut request = http.request(method, url).bearer_auth(&token.token);
    if let Some(body) = body {
        request = request.json(&body);
    } else if bodiless_post {
        // Gateways may answer 411 to a POST without a length, and the HTTP client omits it for an empty body.
        request = request.header(reqwest::header::CONTENT_LENGTH, 0);
    }
    let mut response = request
        .send()
        .await
        .map_err(|_| anyhow::anyhow!("CI API request failed"))?;
    if !response.status().is_success() {
        bail!("CI API returned HTTP {}", response.status().as_u16());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("CI response interrupted"))?
    {
        // Connect returns metadata only; cap buffering at 64 KiB before parsing JSON.
        if bytes.len() + chunk.len() > 65_536 {
            bail!("CI response exceeds limit");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).context("Invalid CI API response")
}

fn field<'a>(value: &'a Value, name: &str) -> anyhow::Result<&'a str> {
    value
        .get(name)
        .and_then(Value::as_str)
        .with_context(|| format!("CI response missing {name}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ci_private_repository_access_requires_an_explicit_flag() {
        use clap::Parser;
        for enabled in [false, true] {
            let mut input = vec!["boxlite", "ci", "connect", "owner"];
            if enabled {
                input.push("--allow-private-repositories");
            }
            let cli = crate::cli::Cli::try_parse_from(input).unwrap();
            let crate::cli::Commands::Ci(args) = cli.command else {
                panic!("CI command required");
            };
            let CiCommand::Connect(args) = args.command;
            assert_eq!(args.allow_private_repositories, enabled);
        }
        assert!(
            crate::cli::Cli::try_parse_from([
                "boxlite",
                "ci",
                "connect",
                "owner",
                "--allow-public-repositories"
            ])
            .is_err()
        );
    }
    #[tokio::test]
    async fn ci_rejects_invalid_accounts_before_loading_remote_credentials() {
        use clap::Parser;
        for account in ["-foo", &"a".repeat(40)] {
            let cli = crate::cli::Cli::try_parse_from(["boxlite", "ci", "connect", "--", account])
                .unwrap();
            let args = CiArgs {
                command: CiCommand::Connect(ConnectArgs {
                    github_account: account.to_owned(),
                    allow_private_repositories: false,
                    no_browser: true,
                }),
            };
            let error = execute(args, &cli.global).await.unwrap_err();
            assert!(error.to_string().contains("GitHub account must"), "{error}");
        }
    }
    #[test]
    fn ci_endpoint_preserves_context_routing_and_rejects_unsafe_urls() {
        let options =
            BoxliteRestOptions::new("https://api.example/api").with_path_prefix("region/tenant");
        assert_eq!(
            endpoint(&options).unwrap().as_str(),
            "https://api.example/api/v1/region/tenant/ci/connect"
        );
        assert_eq!(
            endpoint(&BoxliteRestOptions::new("https://api.example/v1/"))
                .unwrap()
                .as_str(),
            "https://api.example/v1/ci/connect"
        );
        for url in [
            "https://user:secret@example.com",
            "https://example.com?x=y",
            "http://example.com",
        ] {
            assert!(endpoint(&BoxliteRestOptions::new(url)).is_err());
        }
        assert!(
            endpoint(
                &BoxliteRestOptions::new("https://api.example").with_path_prefix("../foreign")
            )
            .is_err()
        );
    }
}
