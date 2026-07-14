use std::io::Write;

use crate::cli::GlobalFlags;
use crate::formatter::{self, OutputFormat};
use boxlite::ExecutionInfo;
use clap::Args;
use serde::Serialize;
use tabled::Tabled;

#[derive(Args, Debug)]
pub struct TopArgs {
    /// Box ID or name
    #[arg(index = 1, value_name = "BOX")]
    pub target_box: String,
}

#[derive(Tabled, Serialize)]
struct ExecutionPresenter {
    #[tabled(rename = "EXEC ID")]
    #[serde(rename = "ExecID")]
    execution_id: String,

    #[tabled(rename = "COMMAND")]
    #[serde(rename = "Command")]
    command: String,

    #[tabled(rename = "STATUS")]
    #[serde(rename = "Status")]
    status: String,

    #[tabled(rename = "ATTACHED")]
    #[serde(rename = "Attached")]
    attached: String,
}

impl From<ExecutionInfo> for ExecutionPresenter {
    fn from(info: ExecutionInfo) -> Self {
        Self {
            execution_id: info.execution_id,
            command: info.command.unwrap_or_default(),
            status: info.status,
            attached: if info.attached { "yes" } else { "no" }.to_string(),
        }
    }
}

pub async fn execute(args: TopArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let rt = global.create_runtime()?;
    let litebox = rt
        .get(&args.target_box)
        .await?
        .ok_or_else(|| anyhow::anyhow!("No such box: {}", args.target_box))?;
    let executions = litebox.list_executions().await?;
    let presenters: Vec<ExecutionPresenter> = executions
        .into_iter()
        .map(ExecutionPresenter::from)
        .collect();

    formatter::print_output(
        &mut std::io::stdout().lock(),
        &presenters,
        OutputFormat::Table,
        |writer, data| {
            let table = formatter::create_table(data).to_string();
            writeln!(writer, "{}", table)?;
            Ok(())
        },
    )?;
    Ok(())
}
