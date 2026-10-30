use crate::cli::GlobalFlags;
use crate::formatter::{self, OutputFormat};
use crate::terminal::StreamManager;
use boxlite::{AttachOptions, ExecutionInfo, LiteBox};
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
    #[tabled(rename = "PID")]
    pid: u32,
    #[tabled(rename = "TTY")]
    tty: bool,
    #[tabled(rename = "MAIN")]
    is_main: bool,
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
            pid: info.pid,
            tty: info.tty,
            is_main: info.is_main,
            started_at: info.started_at,
            command: info.argv.join(" "),
            argv: info.argv,
        }
    }
}

pub async fn top(args: TopArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let rt = global.create_runtime()?;
    let bx = get_box(&rt, &args.target_box).await?;
    let executions = bx.list_executions().await?;
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

#[derive(Args, Debug)]
pub struct AttachArgs {
    pub target_box: String,
    pub execution_id: String,
    /// Attach without sending stdin
    #[arg(long)]
    pub no_stdin: bool,
}

pub async fn attach(args: AttachArgs, global: &GlobalFlags) -> anyhow::Result<i32> {
    let rt = global.create_runtime()?;
    let bx = get_box(&rt, &args.target_box).await?;
    let info = bx
        .list_executions()
        .await?
        .into_iter()
        .find(|item| item.execution_id == args.execution_id)
        .ok_or_else(|| anyhow::anyhow!("No such execution: {}", args.execution_id))?;
    let tty = info.tty;
    let options = AttachOptions::execution(&args.execution_id);
    let options = if args.no_stdin {
        options.read_only()
    } else {
        options
    };
    let mut handle = bx.attach(options).await?;
    let code = StreamManager::new(&mut handle, !args.no_stdin, tty)
        .start()
        .await?;
    let _ = rt.shutdown(None).await;
    Ok(crate::util::to_shell_exit_code(code))
}

#[derive(Args, Debug)]
pub struct KillArgs {
    pub target_box: String,
    pub execution_id: String,
}

pub async fn kill(args: KillArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let rt = global.create_runtime()?;
    let bx = get_box(&rt, &args.target_box).await?;
    bx.get_execution(&args.execution_id).await?.kill().await?;
    Ok(())
}

#[derive(Args, Debug)]
pub struct SignalArgs {
    pub target_box: String,
    pub execution_id: String,
    pub signal: i32,
}

pub async fn signal(args: SignalArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let rt = global.create_runtime()?;
    let bx = get_box(&rt, &args.target_box).await?;
    bx.get_execution(&args.execution_id)
        .await?
        .signal(args.signal)
        .await?;
    Ok(())
}

async fn get_box(rt: &boxlite::BoxliteRuntime, id: &str) -> anyhow::Result<LiteBox> {
    rt.get(id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("No such box: {id}"))
}
