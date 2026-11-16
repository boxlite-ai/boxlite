//! Runtime directory delivery on a running Box (M6).
//!
//! Hidden from `--help`: the surface is for the native-VM experimental flow
//! and tooling, gated behind `BOXLITE_EXPERIMENTAL=native-vmm`.

use clap::{Args, Subcommand};

use crate::cli::GlobalFlags;
use crate::formatter::{self, OutputFormat};
use boxlite::{MountRequest, experimental::ExperimentalFeature};

#[derive(Args, Debug)]
pub struct MountArgs {
    #[command(subcommand)]
    pub command: MountSubcommand,
}

#[derive(Subcommand, Debug)]
pub enum MountSubcommand {
    /// Deliver a host directory into the running container
    Add(AddArgs),
    /// Lazily detach the mount at a container target
    Rm(RmArgs),
    /// List every runtime mount of the Box
    Ls(LsArgs),
    /// Show the runtime mount at a container target
    Inspect(InspectArgs),
}

#[derive(Args, Debug)]
pub struct AddArgs {
    /// Name or ID of the Box
    #[arg(required = true)]
    pub target: String,

    /// Host directory to deliver (must be a real directory, no symlinks)
    #[arg(long, value_name = "HOST_DIR")]
    pub source: std::path::PathBuf,

    /// Absolute path inside the container
    #[arg(long, value_name = "CONTAINER_PATH")]
    pub box_path: String,

    /// Deliver read-only (content policy still follows the export)
    #[arg(long)]
    pub read_only: bool,
}

#[derive(Args, Debug)]
pub struct RmArgs {
    /// Name or ID of the Box
    #[arg(required = true)]
    pub target: String,

    /// Absolute path inside the container
    #[arg(long, value_name = "CONTAINER_PATH")]
    pub box_path: String,
}

#[derive(Args, Debug)]
pub struct LsArgs {
    /// Name or ID of the Box
    #[arg(required = true)]
    pub target: String,

    /// Output format (table, json, yaml)
    #[arg(long, default_value = "table")]
    pub format: String,
}

#[derive(Args, Debug)]
pub struct InspectArgs {
    /// Name or ID of the Box
    #[arg(required = true)]
    pub target: String,

    /// Absolute path inside the container
    #[arg(long, value_name = "CONTAINER_PATH")]
    pub box_path: String,

    /// Output format (table, json, yaml)
    #[arg(long, default_value = "table")]
    pub format: String,
}

fn require_native(global: &GlobalFlags) -> anyhow::Result<()> {
    global
        .experimental_features
        .require(ExperimentalFeature::NativeVmm)
        .map_err(anyhow::Error::from)
}

async fn open_box(global: &GlobalFlags, target: &str) -> anyhow::Result<boxlite::LiteBox> {
    let runtime = global.create_runtime()?;
    runtime
        .get(target)
        .await?
        .ok_or_else(|| anyhow::anyhow!("No such box: {}", target))
}

#[derive(Clone, serde::Serialize, tabled::Tabled)]
struct MountPresenter {
    #[tabled(rename = "SOURCE")]
    #[serde(rename = "Source")]
    source: String,
    #[tabled(rename = "TARGET")]
    #[serde(rename = "Target")]
    target: String,
    #[tabled(rename = "MODE")]
    #[serde(rename = "Mode")]
    mode: String,
    #[tabled(rename = "STATE")]
    #[serde(rename = "State")]
    state: String,
}

impl From<&boxlite::MountInfo> for MountPresenter {
    fn from(info: &boxlite::MountInfo) -> Self {
        Self {
            source: info.source.display().to_string(),
            target: info.target.display().to_string(),
            mode: if info.read_only { "ro" } else { "rw" }.into(),
            state: match info.state {
                boxlite::MountState::Mounted => "mounted".into(),
                boxlite::MountState::Detaching => "detaching".into(),
            },
        }
    }
}

fn print_mounts(writer: &mut dyn std::io::Write, mounts: &[MountPresenter]) -> anyhow::Result<()> {
    let table = formatter::create_table(mounts).to_string();
    writeln!(writer, "{}", table)?;
    Ok(())
}

fn emit(presenters: &[MountPresenter], format: &str) -> anyhow::Result<()> {
    let format = OutputFormat::from_str(format)?;
    formatter::print_output(
        &mut std::io::stdout().lock(),
        &presenters.to_vec(),
        format,
        |writer, data| print_mounts(writer, data),
    )
}

pub async fn execute(args: MountArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    require_native(global)?;
    match args.command {
        MountSubcommand::Add(args) => {
            let box_handle = open_box(global, &args.target).await?;
            let info = box_handle
                .mounts()
                .add(MountRequest {
                    source: args.source.clone(),
                    target: std::path::PathBuf::from(&args.box_path),
                    read_only: args.read_only,
                })
                .await
                .map_err(|error| anyhow::anyhow!("mount failed: {error}"))?;
            emit(&[MountPresenter::from(&info)], "table")
        }
        MountSubcommand::Rm(args) => {
            let box_handle = open_box(global, &args.target).await?;
            box_handle
                .mounts()
                .remove(&args.box_path)
                .await
                .map_err(|error| anyhow::anyhow!("unmount failed: {error}"))?;
            println!("{}", args.box_path);
            Ok(())
        }
        MountSubcommand::Ls(args) => {
            let box_handle = open_box(global, &args.target).await?;
            let mounts = box_handle
                .mounts()
                .list()
                .await
                .map_err(|error| anyhow::anyhow!("list failed: {error}"))?;
            let presenters: Vec<MountPresenter> = mounts.iter().map(MountPresenter::from).collect();
            emit(&presenters, &args.format)
        }
        MountSubcommand::Inspect(args) => {
            let box_handle = open_box(global, &args.target).await?;
            let info = box_handle
                .mounts()
                .get(&args.box_path)
                .await
                .map_err(|error| anyhow::anyhow!("inspect failed: {error}"))?
                .ok_or_else(|| anyhow::anyhow!("No mount at {}", args.box_path))?;
            emit(&[MountPresenter::from(&info)], &args.format)
        }
    }
}
