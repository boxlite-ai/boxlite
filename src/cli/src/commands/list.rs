use crate::cli::GlobalFlags;
use crate::formatter::{self, OutputFormat};
use boxlite::BoxInfo;
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
}

impl From<BoxInfo> for BoxPresenter {
    fn from(info: BoxInfo) -> Self {
        Self {
            id: info.id.to_string(),
            image: info.image,
            status: format!("{:?}", info.status),
            created: formatter::format_time(&info.created_at),
            names: info.name.unwrap_or_default(),
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
