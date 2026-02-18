use crate::cli::GlobalFlags;
use crate::formatter;
use boxlite::BoxStatus;
use clap::Args;
use clap::ValueEnum;
use serde::Serialize;

/// System-wide runtime information (CLI output shape).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemInfo {
    version: String,
    home_dir: String,
    virtualization: String,
    os: String,
    arch: String,
    boxes_total: u32,
    boxes_running: u32,
    boxes_stopped: u32,
    boxes_configured: u32,
    images_count: u32,
}

/// Display system-wide runtime information (default: YAML).
#[derive(Args, Debug)]
pub struct InfoArgs {
    /// Output format (yaml, json)
    #[arg(long, default_value_t = InfoFormat::Yaml, value_enum)]
    pub format: InfoFormat,
}

#[derive(Default, Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum InfoFormat {
    #[default]
    Yaml,
    Json,
}

pub async fn execute(args: InfoArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let options = global.resolve_runtime_options()?;
    let home_dir = options.home_dir.to_string_lossy().to_string();

    let rt = global.create_runtime_with_options(options)?;
    let version = boxlite::VERSION.to_string();
    let virtualization = boxlite::vmm::host_check::check_virtualization_support()
        .map(|s| s.reason)
        .unwrap_or_else(|e| format!("unavailable: {}", e));
    let os = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();

    let boxes_list = rt.list_info().await?;
    let boxes_total = boxes_list.len() as u32;
    let boxes_running = boxes_list.iter().filter(|b| b.status.is_active()).count() as u32;
    let boxes_stopped = boxes_list
        .iter()
        .filter(|b| b.status == BoxStatus::Stopped)
        .count() as u32;
    let boxes_configured = boxes_list
        .iter()
        .filter(|b| b.status == BoxStatus::Configured)
        .count() as u32;

    let images_count = rt.images()?.list().await?.len() as u32;

    let info = SystemInfo {
        version,
        home_dir,
        virtualization,
        os,
        arch,
        boxes_total,
        boxes_running,
        boxes_stopped,
        boxes_configured,
        images_count,
    };

    let out = match args.format {
        InfoFormat::Yaml => formatter::format_yaml(&info)?,
        InfoFormat::Json => formatter::format_json(&info)?,
    };
    println!("{}", out);
    Ok(())
}
