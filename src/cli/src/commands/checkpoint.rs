//! REST checkpoint commands use CheckpointHandle.

use std::io::Write;

use anyhow::{Result, bail};
use boxlite::{BoxliteRuntime, CheckpointInfo};
use clap::{Args, Subcommand};
use tabled::Tabled;

use crate::cli::GlobalFlags;
use crate::formatter::{self, OutputFormat};

#[derive(Args, Debug)]
pub struct CheckpointArgs {
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

pub(crate) fn runtime(global: &GlobalFlags) -> Result<BoxliteRuntime> {
    if !global.targets_rest()? {
        bail!(
            "checkpoints are only implemented for REST runtimes; select a REST context or use --url"
        );
    }
    global.create_runtime()
}

pub async fn execute(args: CheckpointArgs, global: &GlobalFlags) -> Result<()> {
    let rt = runtime(global)?;
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
