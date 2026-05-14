//! `boxlite auth logout` — delete the stored credentials file. If the
//! profile holds an OAuth refresh token, best-effort revoke it server-side
//! (RFC 7009) with a tight timeout so a slow/unreachable server doesn't
//! block local logout.

use std::io::Write;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::Args;

use crate::credentials;

const REVOKE_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Args, Debug, Clone)]
pub struct LogoutArgs {
    /// Skip the confirmation prompt.
    #[arg(long, short = 'y')]
    pub yes: bool,
}

pub async fn run(args: LogoutArgs) -> Result<()> {
    let path = credentials::path().context("resolving credentials path")?;
    if !path.exists() {
        println!("Not logged in.");
        return Ok(());
    }

    if !args.yes {
        print!("Remove stored credentials at {}? [y/N]: ", path.display());
        std::io::stdout().flush().ok();
        let mut buf = String::new();
        std::io::stdin()
            .read_line(&mut buf)
            .context("reading confirmation from stdin")?;
        let answer = buf.trim();
        if !matches!(answer, "y" | "Y" | "yes" | "Yes") {
            println!("Aborted.");
            return Ok(());
        }
    }

    // Best-effort server-side revocation. Local cleanup wins regardless.
    if let Ok(Some(profile)) = credentials::load()
        && let Some(oauth) = profile.oauth.as_ref()
        && let Err(err) = revoke(&profile.url, &oauth.refresh_token).await
    {
        tracing::debug!("revoke failed (continuing with local logout): {err}");
    }

    let removed = credentials::delete()?;
    if removed {
        println!("Logged out");
    } else {
        println!("Not logged in");
    }
    Ok(())
}

async fn revoke(url: &str, refresh_token: &str) -> Result<()> {
    let client = reqwest::Client::builder()
        .timeout(REVOKE_TIMEOUT)
        .build()
        .context("building revoke client")?;
    let revoke_url = format!("{}/v1/oauth/revoke", url.trim_end_matches('/'));
    let _ = client
        .post(&revoke_url)
        .form(&[
            ("token", refresh_token),
            ("token_type_hint", "refresh_token"),
        ])
        .send()
        .await
        .context("POST /v1/oauth/revoke")?;
    // RFC 7009 §2.2: server always returns 200; failures are advisory only.
    Ok(())
}
