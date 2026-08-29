use crate::cli::GlobalFlags;
use crate::formatter::{self, OutputFormat};
use boxlite::{BoxInfo, Seconds};
use chrono::Utc;
use clap::Args;
use serde::Serialize;
use tabled::Tabled;

/// List boxes
#[derive(Args, Debug)]
pub struct ListArgs {
    /// Show all boxes (default just shows running)
    #[arg(short = 'a', long)]
    pub all: bool,

    /// Only show IDs
    #[arg(short, long)]
    pub quiet: bool,

    /// Output format (table, json, yaml)
    #[arg(long, default_value = "table")]
    pub format: String,
}

#[derive(Tabled, Serialize)]
struct BoxPresenter {
    #[tabled(rename = "ID")]
    #[serde(rename = "ID")]
    id: String,

    #[tabled(rename = "IMAGE")]
    #[serde(rename = "Image")]
    image: String,

    #[tabled(rename = "STATUS")]
    #[serde(rename = "Status")]
    status: String,

    #[tabled(rename = "CREATED")]
    #[serde(rename = "CreatedAt")]
    created: String,

    #[tabled(rename = "NAMES")]
    #[serde(rename = "Names")]
    names: String,

    #[tabled(rename = "AUTO-STOP")]
    #[serde(rename = "AutoStop")]
    auto_stop: String,

    #[tabled(rename = "AUTO-DELETE")]
    #[serde(rename = "AutoDelete")]
    auto_delete: String,
}

/// Render a lifecycle window, or `off` when the deadline is disabled.
fn window(seconds: u32) -> String {
    if seconds == 0 {
        "off".to_string()
    } else {
        Seconds::from_seconds(u64::from(seconds)).to_string()
    }
}

/// Render the AutoDelete cell.
///
/// A pending deletion is state, not configuration, so a box at rest shows how
/// long it actually has left rather than the window it was configured with —
/// the deadline is the thing the reader needs to act on.
fn delete_cell(info: &BoxInfo) -> String {
    delete_cell_at(info, Utc::now())
}

/// `now` is injected so tests measure against a fixed instant. Reading the clock
/// twice — once to build the box, once inside — makes the remaining time depend
/// on how long the test took, which turns "in 6 hours" into a seconds string
/// whenever the two readings straddle a second boundary.
fn delete_cell_at(info: &BoxInfo, now: chrono::DateTime<Utc>) -> String {
    if info.auto_delete == 0 {
        return "off".to_string();
    }
    if !info.status.is_at_rest() {
        return window(info.auto_delete);
    }

    let elapsed = (now - info.last_updated).num_seconds().max(0) as u64;
    match u64::from(info.auto_delete).checked_sub(elapsed) {
        Some(0) | None => "due".to_string(),
        Some(remaining) => format!("in {}", Seconds::from_seconds(remaining)),
    }
}

impl From<BoxInfo> for BoxPresenter {
    fn from(info: BoxInfo) -> Self {
        Self {
            id: info.id.to_string(),
            image: info.image.clone(),
            status: format!("{:?}", info.status),
            created: formatter::format_time(&info.created_at),
            auto_stop: window(info.auto_stop),
            auto_delete: delete_cell(&info),
            names: info.name.clone().unwrap_or_default(),
        }
    }
}

pub async fn execute(args: ListArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let rt = global.create_runtime()?;
    let boxes = rt.list_info().await?;

    let boxes: Vec<BoxInfo> = boxes
        .into_iter()
        .filter(|info| args.all || info.status.is_active())
        .collect();

    if args.quiet {
        for info in boxes {
            println!("{}", info.id);
        }
        return Ok(());
    }

    let presenters: Vec<BoxPresenter> = boxes.into_iter().map(BoxPresenter::from).collect();
    let format = OutputFormat::from_str(&args.format)?;
    formatter::print_output(
        &mut std::io::stdout().lock(),
        &presenters,
        format,
        |writer, data| {
            print_boxes(writer, data)?;
            Ok(())
        },
    )?;

    Ok(())
}

fn print_boxes(writer: &mut dyn std::io::Write, boxes: &[BoxPresenter]) -> anyhow::Result<()> {
    let table = formatter::create_table(boxes).to_string();
    writeln!(writer, "{}", table)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use boxlite::{BoxID, BoxStatus, HealthStatus};
    use chrono::Duration;
    use std::collections::HashMap;

    #[test]
    fn a_disabled_deadline_reads_as_off_not_zero() {
        // "0 seconds" would read as a deadline that fires immediately, which is
        // the opposite of what the sentinel means.
        assert_eq!(window(0), "off");
        assert_eq!(window(900), "15 minutes");
        assert_eq!(window(7_200), "2 hours");
        assert_eq!(window(604_800), "7 days");
    }

    /// A fixed reference instant, so the assertions never straddle a real
    /// second boundary between building the box and rendering it.
    fn fixed_now() -> chrono::DateTime<Utc> {
        chrono::DateTime::from_timestamp(1_700_000_000, 0).expect("valid timestamp")
    }

    /// Build a stopped box that stopped `stopped_ago` before [`fixed_now`].
    fn stopped_box(auto_delete: u32, stopped_ago: Duration) -> BoxInfo {
        let now = fixed_now();
        BoxInfo {
            id: BoxID::parse("list-cell-box").unwrap(),
            name: None,
            status: BoxStatus::Stopped,
            created_at: now,
            last_updated: now - stopped_ago,
            pid: None,
            image: "alpine:latest".into(),
            cpus: 1,
            memory_mib: 512,
            network: None,
            labels: HashMap::new(),
            auto_stop: 0,
            auto_delete,
            auto_resume: true,
            health_status: HealthStatus::new(),
            exit_code: None,
            started_at: None,
        }
    }

    #[test]
    fn a_running_box_shows_its_configured_delete_window() {
        let mut info = stopped_box(3_600, Duration::zero());
        info.status = BoxStatus::Running;
        assert_eq!(delete_cell_at(&info, fixed_now()), "1 hours");
    }

    #[test]
    fn a_stopped_box_shows_the_time_it_has_left() {
        // The operator needs the deadline, not the setting: this box was
        // configured for a day and has six hours of that left.
        let info = stopped_box(86_400, Duration::hours(18));
        assert_eq!(delete_cell_at(&info, fixed_now()), "in 6 hours");
    }

    #[test]
    fn a_failed_box_shows_the_time_it_has_left() {
        // The sweeper counts Failed as at rest (`BoxStatus::is_at_rest`) and deletes
        // it on schedule, so ls must show the same countdown it shows for a Stopped
        // box. Rendering the configured window here would misreport exactly the
        // boxes nobody goes back to clean up.
        let mut info = stopped_box(86_400, Duration::hours(18));
        info.status = BoxStatus::Failed;
        assert_eq!(delete_cell_at(&info, fixed_now()), "in 6 hours");

        let mut overdue = stopped_box(3_600, Duration::hours(5));
        overdue.status = BoxStatus::Failed;
        assert_eq!(delete_cell_at(&overdue, fixed_now()), "due");
    }

    #[test]
    fn an_elapsed_deadline_reads_as_due_not_as_a_wrapped_duration() {
        // `checked_sub` guards this: unsigned arithmetic would otherwise wrap a
        // passed deadline into an enormous remaining time.
        let info = stopped_box(3_600, Duration::hours(5));
        assert_eq!(delete_cell_at(&info, fixed_now()), "due");

        let exactly_now = stopped_box(3_600, Duration::seconds(3_600));
        assert_eq!(delete_cell_at(&exactly_now, fixed_now()), "due");
    }

    #[test]
    fn autodelete_off_reads_as_off_in_every_state() {
        for status in [BoxStatus::Running, BoxStatus::Stopped] {
            let mut info = stopped_box(0, Duration::hours(100));
            info.status = status;
            assert_eq!(
                delete_cell_at(&info, fixed_now()),
                "off",
                "status {status:?}"
            );
        }
    }
}
