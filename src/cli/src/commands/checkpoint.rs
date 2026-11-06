//! Checkpoint commands use the same management handle for local and REST.

use std::io::Write;
use std::path::PathBuf;

use anyhow::{Result, bail};
use boxlite::{BoxliteRuntime, CheckpointInfo};
use clap::{Args, Subcommand};
use tabled::Tabled;

use crate::cli::GlobalFlags;
use crate::formatter::{self, OutputFormat};

#[derive(Args, Debug, Default)]
pub struct StorageArgs {
    /// Local checkpoint directory; defaults to <BOXLITE_HOME>/checkpoints.
    #[arg(long, global = true, value_name = "PATH")]
    pub checkpoints_dir: Option<PathBuf>,
}

#[derive(Args, Debug)]
pub struct CheckpointArgs {
    #[command(flatten)]
    pub storage: StorageArgs,
    #[command(subcommand)]
    pub command: CheckpointCommand,
}

#[derive(Subcommand, Debug)]
pub enum CheckpointCommand {
    /// Capture a box's disk and execution configuration.
    Create(CaptureArgs),
    /// List checkpoints independently of source boxes.
    #[command(visible_alias = "ls")]
    List(ListArgs),
    /// Show checkpoint metadata.
    #[command(visible_alias = "inspect")]
    Get(GetArgs),
    /// Delete checkpoints without deleting boxes created from them.
    #[command(visible_alias = "rm")]
    Delete(DeleteArgs),
}

#[derive(Args, Debug)]
pub struct CaptureArgs {
    pub source: String,
    #[arg(long)]
    pub name: Option<String>,
}

#[derive(Args, Debug)]
pub struct ListArgs {
    #[arg(short, long, conflicts_with = "format")]
    pub quiet: bool,
    #[arg(long, default_value = "table")]
    pub format: String,
}

#[derive(Args, Debug)]
pub struct GetArgs {
    pub checkpoint: String,
    #[arg(long, default_value = "json")]
    pub format: String,
}

#[derive(Args, Debug)]
pub struct DeleteArgs {
    #[arg(required = true)]
    pub checkpoints: Vec<String>,
    /// Ignore missing checkpoints; never bypass an in-use archive.
    #[arg(short, long)]
    pub force: bool,
}

pub(crate) fn runtime(global: &GlobalFlags, storage: &StorageArgs) -> Result<BoxliteRuntime> {
    if global.targets_rest()? {
        if storage.checkpoints_dir.is_some() {
            bail!("--checkpoints-dir is local; configure checkpoint storage on the server");
        }
        return global.create_runtime();
    }
    global.create_runtime_with_options(local_options(global, storage)?)
}

fn local_options(global: &GlobalFlags, storage: &StorageArgs) -> Result<boxlite::BoxliteOptions> {
    let mut options = global.resolve_runtime_options()?;
    if let Some(directory) = &storage.checkpoints_dir {
        options.checkpoints_dir = Some(directory.clone());
    }
    Ok(options)
}

pub async fn execute(args: CheckpointArgs, global: &GlobalFlags) -> Result<()> {
    let rt = runtime(global, &args.storage)?;
    let checkpoints = rt.checkpoints();
    match args.command {
        CheckpointCommand::Create(args) => {
            let info = checkpoints.create(&args.source, args.name).await?;
            println!("{}", info.id);
        }
        CheckpointCommand::List(args) => {
            let format = OutputFormat::from_str(&args.format)?;
            let infos = checkpoints.list().await?;
            if args.quiet {
                for info in infos {
                    println!("{}", info.id);
                }
            } else {
                formatter::print_output(
                    &mut std::io::stdout().lock(),
                    &infos,
                    format,
                    |writer, infos| table(writer, infos),
                )?;
            }
        }
        CheckpointCommand::Get(args) => {
            let format = OutputFormat::from_str(&args.format)?;
            let info = checkpoints.get(&args.checkpoint).await?;
            formatter::print_output(
                &mut std::io::stdout().lock(),
                &info,
                format,
                |writer, info| table(writer, std::slice::from_ref(info)),
            )?;
        }
        CheckpointCommand::Delete(args) => {
            for key in args.checkpoints {
                checkpoints.remove(&key, args.force).await?;
                println!("{key}");
            }
        }
    }
    Ok(())
}

#[derive(Tabled)]
struct Row {
    #[tabled(rename = "ID")]
    id: String,
    #[tabled(rename = "NAME")]
    name: String,
    #[tabled(rename = "SOURCE")]
    source: String,
    #[tabled(rename = "STATE")]
    state: String,
    #[tabled(rename = "SIZE")]
    size: String,
    #[tabled(rename = "CREATED")]
    created: String,
}

fn table(writer: &mut dyn Write, infos: &[CheckpointInfo]) -> Result<()> {
    let rows: Vec<_> = infos
        .iter()
        .map(|info| Row {
            id: info.id.clone(),
            name: info.name.clone(),
            source: info.source_box_id.clone(),
            state: format!("{:?}", info.state).to_lowercase(),
            size: crate::commands::volume::ls::format_size(Some(info.size_bytes)),
            created: formatter::format_time(&info.created_at),
        })
        .collect();
    writeln!(writer, "{}", formatter::create_table(rows))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Cli, Commands};
    use clap::Parser;

    #[test]
    fn checkpoint_storage_flag_overrides_the_loaded_configuration() {
        let temporary = tempfile::tempdir().unwrap();
        let config = temporary.path().join("config.json");
        let home = temporary.path().join("runtime");
        let explicit = temporary.path().join("explicit");
        std::fs::write(
            &config,
            serde_json::to_vec(&serde_json::json!({
                "home_dir": home, "checkpoints_dir": temporary.path().join("configured")
            }))
            .unwrap(),
        )
        .unwrap();
        let cli = Cli::try_parse_from([
            "boxlite",
            "--config",
            config.to_str().unwrap(),
            "checkpoint",
            "--checkpoints-dir",
            explicit.to_str().unwrap(),
            "list",
        ])
        .unwrap();
        let Commands::Checkpoint(args) = cli.command else {
            panic!("expected checkpoint command");
        };
        let options = local_options(&cli.global, &args.storage).unwrap();
        assert_eq!(options.home_dir, home);
        assert_eq!(options.checkpoints_directory().unwrap(), explicit);
    }
}
