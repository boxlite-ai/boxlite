use crate::cli::GlobalFlags;
use crate::formatter::{self, OutputFormat};
use boxlite::ExecutionInfo;
use clap::Args;
use serde::Serialize;
use std::io::Write;
use tabled::Tabled;

#[derive(Args, Debug)]
pub struct TopArgs {
    /// Box ID or name
    pub target_box: String,
    /// Only show execution IDs
    #[arg(short, long, conflicts_with = "format")]
    pub quiet: bool,
    /// Output format (table, json, yaml)
    #[arg(long, default_value = "table")]
    pub format: String,
}

#[derive(Tabled, Serialize)]
struct ExecutionPresenter {
    #[tabled(rename = "ID")]
    #[serde(rename = "execution_id")]
    execution_id: String,
    #[tabled(rename = "TTY")]
    tty: bool,
    #[tabled(rename = "MAIN")]
    is_main_session: bool,
    #[tabled(rename = "STARTED (UNIX MS)")]
    #[serde(rename = "started_at")]
    started_at: u64,
    #[tabled(skip)]
    argv: Vec<String>,
    #[serde(skip)]
    #[tabled(rename = "COMMAND")]
    command: String,
}

impl From<ExecutionInfo> for ExecutionPresenter {
    fn from(info: ExecutionInfo) -> Self {
        Self {
            execution_id: info.execution_id,
            tty: info.tty,
            is_main_session: info.is_main_session,
            started_at: info.started_at,
            command: info.argv.join(" "),
            argv: info.argv,
        }
    }
}

pub async fn execute(args: TopArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let rt = global.create_runtime()?;
    let bx = rt
        .get(&args.target_box)
        .await?
        .ok_or_else(|| anyhow::anyhow!("No such box: {}", args.target_box))?;
    let executions = bx.executions().list().await?;
    if args.quiet {
        for execution in executions {
            println!("{}", execution.execution_id);
        }
        return Ok(());
    }
    let rows: Vec<_> = executions
        .into_iter()
        .map(ExecutionPresenter::from)
        .collect();
    let format = OutputFormat::from_str(&args.format)?;
    formatter::print_output(
        &mut std::io::stdout().lock(),
        &rows,
        format,
        |writer, data| {
            writeln!(writer, "{}", formatter::create_table(data))?;
            Ok(())
        },
    )
}
