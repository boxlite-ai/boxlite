//! Docker-style target selection. Preferences are separate from credentials:
//! switching never rewrites tokens, and logout cannot redirect later commands.

use std::io::Write;

use anyhow::{Context, Result, bail};
use clap::{Args, Subcommand};
use serde::{Deserialize, Serialize};

use crate::cli::{Cli, Commands, GlobalFlags};
use crate::credentials::{CredentialStore, DEFAULT_PROFILE, Profile};

#[derive(Args, Debug)]
pub struct ContextArgs {
    #[command(subcommand)]
    pub command: ContextCommand,
}

#[derive(Subcommand, Debug)]
pub enum ContextCommand {
    /// Set the current context for subsequent commands.
    Use { name: String },
    /// List contexts, marking the effective context with an asterisk.
    #[command(visible_alias = "list")]
    Ls {
        /// Only show context names.
        #[arg(short, long)]
        quiet: bool,
    },
    /// Print the effective context name, including flag/environment overrides.
    Show,
}

#[derive(Debug, Clone)]
pub struct SelectedContext {
    pub name: String,
    pub source: &'static str,
    pub profile: Option<Profile>,
}

#[derive(Default, Deserialize, Serialize)]
struct Preferences {
    #[serde(default)]
    current_context: Option<String>,
    #[serde(flatten)]
    other: toml::Table,
}

fn read_preferences(store: &CredentialStore) -> Result<Preferences> {
    let path = store.path()?.with_file_name("cli.toml");
    let raw = match std::fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Preferences::default());
        }
        Err(error) => return Err(error).context("reading CLI context preferences"),
    };
    toml::from_str(&raw).with_context(|| format!("parsing context preferences {}", path.display()))
}

/// Resolve once before dispatch. Workload commands also snapshot credentials so
/// a concurrent switch/login cannot split backend checks from runtime creation.
pub fn initialize(cli: &mut Cli) -> Result<()> {
    if matches!(
        cli.command,
        Commands::Serve(_)
            | Commands::Pull(_)
            | Commands::Images(_)
            | Commands::Info(_)
            | Commands::Logs(_)
            | Commands::Agent(_)
            | Commands::Completion(_)
    ) {
        return Ok(());
    }
    let global = &mut cli.global;
    let store = global.credential_store();
    let (name, source) = match &global.profile {
        Some(name) => (name.clone(), global.context_source.unwrap_or("--context")),
        None => match read_preferences(&store)?.current_context {
            Some(name) if !name.is_empty() => (name, "saved context"),
            _ => (DEFAULT_PROFILE.to_string(), "default"),
        },
    };
    let profile = if matches!(cli.command, Commands::Auth(_) | Commands::Context(_)) {
        None // Auth may recreate missing credentials; show/use must permit recovery.
    } else {
        let profile = store.load_named(&name)?;
        if profile.is_none() && name != DEFAULT_PROFILE {
            bail!(
                "context `{name}` not found; log in with --context {name}, or use `boxlite context use default`"
            );
        }
        profile
    };
    global.selected_context = Some(SelectedContext {
        name,
        source,
        profile,
    });
    Ok(())
}

pub fn execute(args: ContextArgs, global: &GlobalFlags) -> Result<()> {
    let store = global.credential_store();
    let current = global.resolved_context();
    match args.command {
        ContextCommand::Show => println!("{current}"),
        ContextCommand::Use { name } => {
            if name.is_empty() || name.chars().any(char::is_control) {
                bail!("context name must be nonempty and contain no control characters");
            }
            if name != DEFAULT_PROFILE && store.load_named(&name)?.is_none() {
                bail!(
                    "context `{name}` not found; create it with `boxlite --context {name} auth login`"
                );
            }
            let mut preferences = read_preferences(&store)?;
            let previous = preferences
                .current_context
                .as_deref()
                .unwrap_or(DEFAULT_PROFILE);
            if previous != name {
                preferences.current_context = (name != DEFAULT_PROFILE).then(|| name.clone());
                let path = store.path()?.with_file_name("cli.toml");
                let parent = path
                    .parent()
                    .context("context preferences have no parent directory")?;
                crate::credentials::create_secure_dir(parent)?;
                // Unique private tempfiles + rename give readers a complete old/new
                // preference. Concurrent switches use last-completed-write wins.
                let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
                temporary.write_all(toml::to_string(&preferences)?.as_bytes())?;
                temporary.as_file().sync_all()?;
                temporary.persist(&path).context("saving current context")?;
            }
            println!("{name}");
            eprintln!("Current context is now \"{name}\"");
            if let Some(source) = global.context_source
                && current != name
            {
                eprintln!(
                    "Warning: {source} overrides the saved context; effective context is `{current}`."
                );
            }
        }
        ContextCommand::Ls { quiet } => {
            let mut profiles = store.load_all()?;
            profiles.entry(DEFAULT_PROFILE.to_string()).or_default();
            if !quiet {
                println!("{:<24} ENDPOINT", "NAME");
            }
            for (name, profile) in profiles {
                if quiet {
                    println!("{name}");
                    continue;
                }
                let endpoint = if name == DEFAULT_PROFILE {
                    global.url.as_deref().unwrap_or(&profile.url)
                } else {
                    &profile.url
                };
                let endpoint = if endpoint.is_empty() {
                    "embedded"
                } else {
                    endpoint
                };
                let marker = if name == current { " *" } else { "" };
                println!("{:<24} {endpoint}", format!("{name}{marker}"));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "contexts/tests/mod.rs"]
mod tests;
