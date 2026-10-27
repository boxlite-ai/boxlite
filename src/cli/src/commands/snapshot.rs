//! Disk snapshot commands. Organization management follows `volume`; --box
//! selects the existing source-box scope, including local runtime snapshots.

use crate::cli::GlobalFlags;
use crate::formatter::{self, OutputFormat};
use boxlite::{BoxliteRuntime, LiteBox, SnapshotInfo, SnapshotOptions};
use clap::{Args, Subcommand};
use serde::Serialize;
use std::io::Write;
use tabled::Tabled;

#[derive(Args, Debug)]
pub struct SnapshotArgs {
    #[command(subcommand)]
    pub command: SnapshotCommand,
}

#[derive(Subcommand, Debug)]
pub enum SnapshotCommand {
    /// Capture a box's disk and print the ready snapshot ID. Cloud sources must be stopped.
    Create(CreateArgs),
    /// List organization snapshots, or snapshots taken from one box.
    #[command(visible_alias = "list")]
    Ls(ListArgs),
    /// Inspect a snapshot by ID or name (by name with a local --box).
    #[command(visible_alias = "inspect")]
    Get(GetArgs),
    /// Delete snapshots permanently.
    #[command(visible_alias = "delete")]
    Rm(RemoveArgs),
    /// Replace an existing box's disk; the cloud target must be stopped.
    Restore(RestoreArgs),
}

#[derive(Args, Debug)]
pub struct CreateArgs {
    pub box_id: String,
    /// Omit or leave blank to generate a name.
    #[arg(long)]
    pub name: Option<String>,
}

#[derive(Args, Debug)]
pub struct ListArgs {
    /// Only snapshots taken from this source box.
    #[arg(long = "box")]
    pub box_id: Option<String>,
    /// Print only snapshot IDs.
    #[arg(short, long, conflicts_with = "format")]
    pub quiet: bool,
    #[arg(long, default_value = "table")]
    pub format: String,
}

#[derive(Args, Debug)]
pub struct GetArgs {
    pub snapshot: String,
    #[arg(long = "box")]
    pub box_id: Option<String>,
    #[arg(long, default_value = "table")]
    pub format: String,
}

#[derive(Args, Debug)]
pub struct RemoveArgs {
    #[arg(required = true, num_args = 1..)]
    pub snapshots: Vec<String>,
    #[arg(long = "box")]
    pub box_id: Option<String>,
    /// Ignore snapshots that do not exist. Other failures remain errors.
    #[arg(short, long)]
    pub force: bool,
}

#[derive(Args, Debug)]
pub struct RestoreArgs {
    pub snapshot: String,
    /// Target box whose disk will be replaced.
    #[arg(long = "box", required = true)]
    pub box_id: String,
}

#[derive(Tabled, Serialize)]
struct SnapshotPresenter {
    #[tabled(rename = "ID")]
    #[serde(rename = "Id")]
    id: String,
    #[tabled(rename = "NAME")]
    #[serde(rename = "Name")]
    name: String,
    #[tabled(rename = "SOURCE BOX")]
    #[serde(rename = "BoxId")]
    box_id: String,
    #[tabled(rename = "STATUS")]
    #[serde(rename = "Status")]
    status: String,
    #[tabled(rename = "CREATED")]
    #[serde(rename = "CreatedAt")]
    created_at: String,
    #[tabled(rename = "SIZE")]
    #[serde(rename = "Size")]
    size: String,
    #[tabled(rename = "ERROR")]
    #[serde(rename = "Error")]
    error: String,
}

impl From<SnapshotInfo> for SnapshotPresenter {
    fn from(info: SnapshotInfo) -> Self {
        let time = chrono::DateTime::from_timestamp(info.created_at, 0).unwrap_or_default();
        Self {
            id: info.id,
            name: info.name,
            box_id: info.box_id,
            status: info.status,
            created_at: formatter::format_time(&time),
            size: crate::commands::volume::ls::format_size(Some(info.disk_info.size_bytes)),
            error: info.error.unwrap_or_default(),
        }
    }
}

async fn get_box(runtime: &BoxliteRuntime, id: &str) -> anyhow::Result<LiteBox> {
    runtime
        .get(id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("Box not found: {id}"))
}

pub async fn execute(args: SnapshotArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let runtime = global.create_runtime()?;
    match args.command {
        SnapshotCommand::Create(args) => {
            let bx = get_box(&runtime, &args.box_id).await?;
            let snapshot = bx
                .snapshots()
                .create(
                    SnapshotOptions::default(),
                    args.name.as_deref().unwrap_or(""),
                )
                .await?;
            println!("{}", snapshot.id);
        }
        SnapshotCommand::Ls(args) => {
            let format = OutputFormat::from_str(&args.format)?;
            let snapshots = match args.box_id {
                Some(id) => get_box(&runtime, &id).await?.snapshots().list().await?,
                None => runtime.snapshots()?.list().await?,
            };
            if args.quiet {
                for snapshot in snapshots {
                    println!("{}", snapshot.id);
                }
            } else {
                let rows: Vec<_> = snapshots.into_iter().map(SnapshotPresenter::from).collect();
                formatter::print_output(
                    &mut std::io::stdout().lock(),
                    &rows,
                    format,
                    |writer, data| {
                        writeln!(writer, "{}", formatter::create_table(data))?;
                        Ok(())
                    },
                )?;
            }
        }
        SnapshotCommand::Get(args) => {
            let format = OutputFormat::from_str(&args.format)?;
            let snapshot = match args.box_id {
                Some(id) => get_box(&runtime, &id)
                    .await?
                    .snapshots()
                    .get(&args.snapshot)
                    .await?
                    .ok_or_else(|| anyhow::anyhow!("Snapshot not found: {}", args.snapshot))?,
                None => runtime.snapshots()?.get(&args.snapshot).await?,
            };
            let row = SnapshotPresenter::from(snapshot);
            formatter::print_output(
                &mut std::io::stdout().lock(),
                &row,
                format,
                |writer, data| {
                    writeln!(writer, "{}", formatter::create_table(std::iter::once(data)))?;
                    Ok(())
                },
            )?;
        }
        SnapshotCommand::Rm(args) => {
            let bx = match args.box_id {
                Some(id) => Some(get_box(&runtime, &id).await?),
                None => None,
            };
            let mut failed = false;
            for snapshot in args.snapshots {
                let result = match &bx {
                    Some(bx) => bx.snapshots().remove(&snapshot).await,
                    None => runtime.snapshots()?.remove(&snapshot, args.force).await,
                };
                match result {
                    Ok(()) => println!("{snapshot}"),
                    Err(boxlite::BoxliteError::NotFound(_)) if args.force => println!("{snapshot}"),
                    Err(error) => {
                        failed = true;
                        eprintln!("Error removing snapshot '{snapshot}': {error}");
                    }
                }
            }
            anyhow::ensure!(!failed, "Some snapshots could not be removed");
        }
        SnapshotCommand::Restore(args) => {
            let bx = get_box(&runtime, &args.box_id).await?;
            bx.snapshots().restore(&args.snapshot).await?;
            println!("{}", bx.id());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
