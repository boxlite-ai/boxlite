use crate::cli::GlobalFlags;
use crate::formatter;
use boxlite::{BoxStatus, BoxliteError};
use clap::Args;
use clap::ValueEnum;
use serde::Serialize;

/// System-wide runtime information (CLI output shape).
///
/// `homeDir` / `virtualization` are populated for the local backend; for
/// REST they become the URL string and a `"remote"` sentinel so the user
/// can see at a glance which environment the count fields describe.
/// `imagesCount` is omitted (set to `None`) when the backend doesn't
/// expose image listing — currently the REST backend, until image
/// endpoints land.
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
    #[serde(skip_serializing_if = "Option::is_none")]
    images_count: Option<u32>,
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
    let rt = global.create_runtime()?;
    let is_rest = rt.is_rest();

    let (home_dir, virtualization) = if is_rest {
        // Local-only fields don't describe the environment the box/image
        // counts come from; render the URL we're talking to instead.
        let url = global
            .resolved_url()
            .unwrap_or_else(|| "(remote)".to_string());
        (url, "remote".to_string())
    } else {
        let options = global.resolve_runtime_options()?;
        let home = options.home_dir.to_string_lossy().to_string();
        let virt = boxlite::system_check::SystemCheck::run()
            .map(|_| "available".to_string())
            .unwrap_or_else(|e| format!("unavailable: {}", e));
        (home, virt)
    };

    let version = boxlite::VERSION.to_string();
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

    // Image listing is local-only today; surface it when the backend
    // supports it and omit the field otherwise (rather than misreporting
    // 0). When REST image endpoints land, removing this branch keeps the
    // count visible.
    let images_count = match rt.images() {
        Ok(handle) => Some(handle.list().await?.len() as u32),
        Err(BoxliteError::Unsupported(_)) => None,
        Err(e) => return Err(e.into()),
    };

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
