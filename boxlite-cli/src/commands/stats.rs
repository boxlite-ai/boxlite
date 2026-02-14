//! Display live metrics for a box.

use crate::cli::GlobalFlags;
use crate::formatter::{self, OutputFormat};
use boxlite::BoxMetrics;
use clap::Args;
use serde::Serialize;
use std::fmt::Write as FmtWrite;
use std::io::{Write, Write as _};
use tabled::Tabled;

#[derive(Args, Debug)]
pub struct StatsArgs {
    /// Box ID or name
    #[arg(index = 1, value_name = "BOX")]
    pub target: String,

    /// Output format (table, json, yaml)
    #[arg(long, default_value = "table")]
    pub format: String,
}

#[derive(Tabled, Serialize)]
struct StatsPresenter {
    #[tabled(rename = "METRIC")]
    #[serde(rename = "Metric")]
    metric: String,

    #[tabled(rename = "VALUE")]
    #[serde(rename = "Value")]
    value: String,
}

/// Execute `stats` command.
pub async fn execute(args: StatsArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let rt = global.create_runtime()?;
    let litebox = rt
        .get(&args.target)
        .await?
        .ok_or_else(|| anyhow::anyhow!("No such box: {}", args.target))?;

    let metrics = litebox.metrics().await?;
    let presenters = format_metrics(metrics);

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

/// Convert BoxMetrics to Vec<StatsPresenter> for display.
fn format_metrics(metrics: BoxMetrics) -> Vec<StatsPresenter> {
    vec![
        StatsPresenter {
            metric: "CPU".to_string(),
            value: format_percent(metrics.cpu_percent),
        },
        StatsPresenter {
            metric: "Memory".to_string(),
            value: format_bytes(metrics.memory_bytes),
        },
        StatsPresenter {
            metric: "Commands".to_string(),
            value: metrics.commands_executed_total.to_string(),
        },
        StatsPresenter {
            metric: "Errors".to_string(),
            value: metrics.exec_errors_total.to_string(),
        },
        StatsPresenter {
            metric: "Boot Time".to_string(),
            value: format_duration_ms(metrics.guest_boot_duration_ms),
        },
        StatsPresenter {
            metric: "Net Sent".to_string(),
            value: format_bytes(metrics.network_bytes_sent),
        },
        StatsPresenter {
            metric: "Net Recv".to_string(),
            value: format_bytes(metrics.network_bytes_received),
        },
        StatsPresenter {
            metric: "TCP Connections".to_string(),
            value: format_optional_u64(metrics.network_tcp_connections),
        },
        StatsPresenter {
            metric: "TCP Errors".to_string(),
            value: format_optional_u64(metrics.network_tcp_errors),
        },
    ]
}

/// Format optional percent value.
fn format_percent(value: Option<f32>) -> String {
    match value {
        Some(p) => format!("{:.1}%", p),
        None => "N/A".to_string(),
    }
}

/// Format optional byte value to human-readable form.
fn format_bytes(value: Option<u64>) -> String {
    match value {
        Some(bytes) => {
            const KB: u64 = 1024;
            const MB: u64 = KB * 1024;
            const GB: u64 = MB * 1024;

            if bytes < KB {
                format!("{} B", bytes)
            } else if bytes < MB {
                format!("{:.1} KiB", bytes as f64 / KB as f64)
            } else if bytes < GB {
                format!("{:.1} MiB", bytes as f64 / MB as f64)
            } else {
                format!("{:.1} GiB", bytes as f64 / GB as f64)
            }
        }
        None => "N/A".to_string(),
    }
}

/// Format optional duration in milliseconds.
fn format_duration_ms(value: Option<u128>) -> String {
    match value {
        Some(ms) => format!("{} ms", ms),
        None => "N/A".to_string(),
    }
}

/// Format optional u64 value.
fn format_optional_u64(value: Option<u64>) -> String {
    match value {
        Some(v) => v.to_string(),
        None => "N/A".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_percent() {
        assert_eq!(format_percent(Some(12.5)), "12.5%".to_string());
        assert_eq!(format_percent(None), "N/A".to_string());
        assert_eq!(format_percent(Some(0.0)), "0.0%".to_string());
    }

    #[test]
    fn test_format_bytes() {
        assert_eq!(format_bytes(Some(1024)), "1.0 KiB".to_string());
        assert_eq!(format_bytes(Some(1024 * 1024)), "1.0 MiB".to_string());
        assert_eq!(
            format_bytes(Some(1024 * 1024 * 1024)),
            "1.0 GiB".to_string()
        );
        assert_eq!(format_bytes(None), "N/A".to_string());
    }

    #[test]
    fn test_format_duration_ms() {
        assert_eq!(format_duration_ms(Some(450)), "450 ms".to_string());
        assert_eq!(format_duration_ms(None), "N/A".to_string());
    }

    #[test]
    fn test_format_optional_u64() {
        assert_eq!(format_optional_u64(Some(42)), "42".to_string());
        assert_eq!(format_optional_u64(None), "N/A".to_string());
    }
}
