use std::io::Write;

use crate::cli::GlobalFlags;
use crate::formatter::{self, OutputFormat};
use boxlite::runtime::types::VolumeInfo;
use clap::Args;
use serde::Serialize;
use tabled::Tabled;

/// List volumes.
#[derive(Args, Debug)]
pub struct LsArgs {
    /// Only show volume ids.
    #[arg(short, long)]
    pub quiet: bool,

    /// Output format (table, json, yaml).
    #[arg(long, default_value = "table")]
    pub format: String,
}

/// Presenter for volume output, shared by `ls` and `get` and used for both
/// table and JSON/YAML formats.
#[derive(Tabled, Serialize)]
pub struct VolumePresenter {
    #[tabled(rename = "ID")]
    #[serde(rename = "Id")]
    pub id: String,
    #[tabled(rename = "CREATED")]
    #[serde(rename = "CreatedAt")]
    pub created: String,
    #[tabled(rename = "SIZE")]
    #[serde(rename = "Size")]
    pub size: String,
}

impl From<&VolumeInfo> for VolumePresenter {
    fn from(info: &VolumeInfo) -> Self {
        Self {
            id: info.id.clone(),
            created: formatter::format_time(&info.created_at),
            size: format_size(info.size_bytes),
        }
    }
}

/// Render an optional byte count as a short human string ("-" when unknown).
pub fn format_size(size_bytes: Option<u64>) -> String {
    match size_bytes {
        Some(bytes) => human_bytes(bytes),
        None => "-".to_string(),
    }
}

/// Format a byte count in binary units (B/KiB/MiB/GiB), matching the compact
/// style CLI users expect. Whole-number bytes stay exact; larger units get one
/// decimal place.
fn human_bytes(bytes: u64) -> String {
    const KIB: u64 = 1024;
    const MIB: u64 = KIB * 1024;
    const GIB: u64 = MIB * 1024;
    if bytes < KIB {
        format!("{bytes}B")
    } else if bytes < MIB {
        format!("{:.1}KiB", bytes as f64 / KIB as f64)
    } else if bytes < GIB {
        format!("{:.1}MiB", bytes as f64 / MIB as f64)
    } else {
        format!("{:.1}GiB", bytes as f64 / GIB as f64)
    }
}

pub async fn run(args: LsArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let rt = global.create_runtime()?;
    let volumes = rt.volumes()?.list().await?;

    if args.quiet {
        for info in &volumes {
            println!("{}", info.id);
        }
        return Ok(());
    }

    let presenters: Vec<VolumePresenter> = volumes.iter().map(Into::into).collect();
    let format = OutputFormat::from_str(&args.format)?;
    formatter::print_output(
        &mut std::io::stdout().lock(),
        &presenters,
        format,
        |writer, data| {
            let table = formatter::create_table(data).to_string();
            writeln!(writer, "{}", table)?;
            Ok(())
        },
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_size_units() {
        assert_eq!(format_size(None), "-");
        assert_eq!(format_size(Some(0)), "0B");
        assert_eq!(format_size(Some(512)), "512B");
        assert_eq!(format_size(Some(1024)), "1.0KiB");
        assert_eq!(format_size(Some(1024 * 1024)), "1.0MiB");
        assert_eq!(format_size(Some(3 * 1024 * 1024 * 1024)), "3.0GiB");
    }
}
