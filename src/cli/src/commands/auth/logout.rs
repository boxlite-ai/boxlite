//! `boxlite auth logout` — delete the stored credentials file.

use std::io::Write;

use anyhow::{Context, Result};
use clap::Args;

use crate::credentials;

#[derive(Args, Debug, Clone)]
pub struct LogoutArgs {
    /// Skip the confirmation prompt.
    #[arg(long, short = 'y')]
    pub yes: bool,
}

pub async fn run(args: LogoutArgs, profile_name: &str) -> Result<()> {
    let path = credentials::path().context("resolving credentials path")?;
    let exists = credentials::load_named(profile_name)
        .ok()
        .flatten()
        .is_some();
    if !exists {
        println!("Not logged in (profile `{}`).", profile_name);
        return Ok(());
    }

    if !args.yes {
        print!(
            "Remove stored credentials for profile `{}` at {}? [y/N]: ",
            profile_name,
            path.display()
        );
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

    let removed = credentials::delete_named(profile_name)?;
    if removed {
        println!("Logged out (profile `{}`)", profile_name);
    } else {
        println!("Not logged in (profile `{}`)", profile_name);
    }
    Ok(())
}
