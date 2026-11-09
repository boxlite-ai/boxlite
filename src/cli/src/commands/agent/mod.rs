//! Agent instance and turn commands.

use crate::cli::GlobalFlags;
use anyhow::{Result, anyhow};
use boxlite::agents::{
    AgentConfig, AgentControlOptions as AgentControlOptionsCore,
    AgentCreateOptions as AgentCreateOptionsCore, AgentEventStream,
    AgentEventsOptions as AgentEventsOptionsCore, AgentResult, AgentSendMode,
    AgentSendOptions as AgentSendOptionsCore, AgentTurnState, AgentTurnStatus,
    AgentWaitOptions as AgentWaitOptionsCore,
};
use boxlite::{Agent, AgentTurn, BoxliteRuntime, LiteBox};
use clap::{Args, Subcommand, ValueEnum};
use futures::StreamExt;
use serde_json::Value;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

mod records;
#[cfg(test)]
mod tests;

#[derive(Args, Debug)]
pub struct AgentArgs {
    #[command(subcommand)]
    pub command: AgentCommand,
}

#[derive(Subcommand, Debug)]
pub enum AgentCommand {
    /// Create an agent instance.
    Create {
        #[command(flatten)]
        target: BoxTarget,
        /// Agent implementation to use
        #[arg(long, value_name = "IMPLEMENTATION")]
        agent: String,
        #[command(flatten)]
        options: AgentCreateOptions,
    },
    /// Close an agent.
    Close {
        #[command(flatten)]
        target: AgentTarget,
        #[command(flatten)]
        options: AgentControlOptions,
    },
    /// Submit text and stream the turn until it ends.
    Send {
        #[command(flatten)]
        target: AgentTarget,
        /// Message text
        text: String,
        #[command(flatten)]
        options: AgentSendOptions,
        /// Return the queued turn at once instead of streaming it
        #[arg(short = 'd', long)]
        detach: bool,
        /// Streamed output: answer text and tool lines, or JSON Lines records
        #[arg(long, value_enum, default_value = "default", conflicts_with = "detach")]
        format: StreamFormat,
    },
    /// Read state, configuration, capabilities or requests.
    Inspect {
        #[command(flatten)]
        target: ReadTarget,
        #[command(flatten)]
        options: AgentInspectOptions,
    },
    /// Open agent or turn events after a cursor.
    Events {
        #[command(flatten)]
        target: ReadTarget,
        #[command(flatten)]
        options: AgentEventsOptions,
    },
    /// Submit an answer or permission response as JSON.
    Respond {
        #[command(flatten)]
        target: AgentTarget,
        /// Request identifier
        #[arg(long, value_name = "REQUEST")]
        request: String,
        /// Typed answer or permission response
        #[arg(value_name = "JSON", value_parser = parse_json)]
        response: Value,
        #[command(flatten)]
        options: AgentControlOptions,
    },
    /// Wait for a turn result.
    Wait {
        #[command(flatten)]
        target: TurnTarget,
        #[command(flatten)]
        options: AgentWaitOptions,
    },
    /// Steer this turn without creating another turn.
    Steer {
        #[command(flatten)]
        target: TurnTarget,
        /// Steering instructions
        text: String,
        #[command(flatten)]
        options: AgentControlOptions,
    },
    /// Interrupt this turn's agent loop.
    Interrupt {
        #[command(flatten)]
        target: TurnTarget,
        #[command(flatten)]
        options: AgentControlOptions,
    },
}

#[derive(Args, Debug)]
pub struct BoxTarget {
    /// Box ID or name
    #[arg(value_name = "BOX")]
    target: String,
}

#[derive(Args, Debug)]
pub struct AgentTarget {
    #[command(flatten)]
    sandbox: BoxTarget,
    /// Agent instance identifier
    #[arg(long = "agent", value_name = "AGENT")]
    agent_id: String,
}

#[derive(Args, Debug)]
pub struct TurnTarget {
    #[command(flatten)]
    agent: AgentTarget,
    /// Turn identifier
    #[arg(long, value_name = "TURN")]
    turn: String,
}

#[derive(Args, Debug)]
pub struct ReadTarget {
    #[command(flatten)]
    agent: AgentTarget,
    /// Select one turn instead of the whole agent
    #[arg(long, value_name = "TURN")]
    turn: Option<String>,
}

#[derive(Args, Debug)]
pub struct AgentCreateOptions {
    /// Working directory inside the Box
    #[arg(long)]
    cwd: Option<PathBuf>,
    /// Initial agent configuration as JSON (not the runtime --config file)
    #[arg(long, value_name = "JSON", value_parser = parse_json)]
    agent_config: Option<Value>,
    #[command(flatten)]
    control: AgentControlOptions,
}

/// How `send` prints a streamed turn, as in `opencode run --format`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum StreamFormat {
    /// Answer text and one line per tool call
    Default,
    /// One JSON record per event, then the Result record
    Json,
}

#[derive(Clone, Debug, PartialEq, Eq, ValueEnum)]
pub enum SendMode {
    Queue,
    Reject,
}

#[derive(Args, Debug)]
pub struct AgentSendOptions {
    /// Admission mode
    #[arg(long, value_enum, default_value = "queue")]
    mode: SendMode,
    /// Additional JSON input
    #[arg(long, value_name = "JSON", value_parser = parse_json)]
    data: Option<Value>,
    #[command(flatten)]
    control: AgentControlOptions,
}

#[derive(Args, Debug)]
pub struct AgentControlOptions {
    /// Retry key
    #[arg(long)]
    idempotency_key: Option<String>,
}

#[derive(Args, Debug)]
pub struct AgentWaitOptions {
    /// Maximum wait in whole seconds; omission means no deadline
    #[arg(long, value_name = "SECONDS")]
    timeout_seconds: Option<u64>,
}

#[derive(Args, Debug)]
pub struct AgentEventsOptions {
    /// Resume after this opaque event cursor
    #[arg(long, value_name = "CURSOR")]
    after: Option<String>,
}

#[derive(Args, Debug)]
pub struct AgentInspectOptions {
    /// Read an agent view instead of state; cannot be combined with --turn
    #[arg(long, value_enum, conflicts_with = "turn")]
    view: Option<AgentView>,
}

#[derive(Clone, Debug, PartialEq, Eq, ValueEnum)]
pub enum AgentView {
    Config,
    Capabilities,
    Requests,
}

fn parse_json(input: &str) -> serde_json::Result<Value> {
    serde_json::from_str(input)
}

/// Run one agent command and print its JSON record on stdout.
///
/// Each run reconnects by ID (`Agents::get`, `Agent::get_turn`), which is how
/// separate CLI processes share one agent.
pub async fn execute(args: AgentArgs, global: &GlobalFlags) -> Result<()> {
    let runtime = global.create_runtime()?;
    match args.command {
        AgentCommand::Create {
            target,
            agent,
            options,
        } => {
            let agents = find_box(&runtime, &target).await?.agents();
            let created = agents.create(&agent, options.into_core()?).await?;
            // Only the ID: later commands target it, and not every adapter
            // reports state (OpenCode does not).
            print(&serde_json::json!({ "id": created.id() }))
        }
        AgentCommand::Close { target, options } => {
            let agent = open_agent(&runtime, &target).await?;
            Ok(agent.close(options.into_core()).await?)
        }
        AgentCommand::Send {
            target,
            text,
            options,
            detach,
            format,
        } => {
            let agent = open_agent(&runtime, &target).await?;
            let turn = agent.send(&text, options.into_core()).await?;
            if detach {
                return print(&records::turn_state(&turn.state()?));
            }
            stream_turn(&agent, &turn, format).await
        }
        AgentCommand::Respond {
            target,
            request,
            response,
            options,
        } => {
            let agent = open_agent(&runtime, &target).await?;
            let response = records::parse_response(response)?;
            let turn = agent
                .respond(&request, response, options.into_core())
                .await?;
            print(&records::turn_state(&turn.state()?))
        }
        AgentCommand::Inspect { target, options } => {
            let agent = open_agent(&runtime, &target.agent).await?;
            let record = match (target.turn, options.view) {
                (Some(turn), _) => records::turn_state(&agent.get_turn(&turn).await?.state()?),
                (None, None) => records::agent_state(&agent.state()?),
                (None, Some(AgentView::Config)) => records::config(&agent.config()?),
                (None, Some(AgentView::Capabilities)) => {
                    records::capabilities(&agent.capabilities()?)
                }
                (None, Some(AgentView::Requests)) => records::requests(&agent.requests().await?),
            };
            print(&record)
        }
        AgentCommand::Events { target, options } => {
            let agent = open_agent(&runtime, &target.agent).await?;
            let options = AgentEventsOptionsCore {
                after: options.after,
            };
            let events = match target.turn {
                Some(turn) => agent.get_turn(&turn).await?.events(options).await?,
                None => agent.events(options).await?,
            };
            print_events(events, &mut std::io::stdout().lock()).await
        }
        AgentCommand::Wait { target, options } => {
            let turn = open_turn(&runtime, &target).await?;
            let options = AgentWaitOptionsCore {
                timeout: options.timeout_seconds.map(Duration::from_secs),
            };
            print(&records::result(&turn.wait(options).await?))
        }
        AgentCommand::Steer {
            target,
            text,
            options,
        } => {
            let turn = open_turn(&runtime, &target).await?;
            print(&records::receipt(
                &turn.steer(&text, options.into_core()).await?,
            ))
        }
        AgentCommand::Interrupt { target, options } => {
            let turn = open_turn(&runtime, &target).await?;
            Ok(turn.interrupt(options.into_core()).await?)
        }
    }
}

async fn find_box(runtime: &BoxliteRuntime, target: &BoxTarget) -> Result<LiteBox> {
    runtime
        .get(&target.target)
        .await?
        .ok_or_else(|| anyhow!("No such box: {}", target.target))
}

async fn open_agent(runtime: &BoxliteRuntime, target: &AgentTarget) -> Result<Agent> {
    let agents = find_box(runtime, &target.sandbox).await?.agents();
    Ok(agents.get(&target.agent_id).await?)
}

async fn open_turn(runtime: &BoxliteRuntime, target: &TurnTarget) -> Result<AgentTurn> {
    let agent = open_agent(runtime, &target.agent).await?;
    Ok(agent.get_turn(&target.turn).await?)
}

fn print(record: &Value) -> Result<()> {
    println!("{record}");
    Ok(())
}

/// Stream a submitted turn, then report how it ended: exit 0 only when it
/// completed. A turn waiting for input ends the stream, because nothing can
/// answer it through this command; the turn itself stays in the Box.
async fn stream_turn(agent: &Agent, turn: &AgentTurn, format: StreamFormat) -> Result<()> {
    let turn_id = turn.state()?.id;
    if format == StreamFormat::Default {
        eprintln!("turn {turn_id}");
    }
    let events = turn.events(AgentEventsOptionsCore::default()).await?;
    let mut stdout = std::io::stdout().lock();
    match format {
        StreamFormat::Json => print_events(events, &mut stdout).await?,
        StreamFormat::Default => print_text(events, &mut stdout).await?,
    }
    let state = agent.get_turn(&turn_id).await?.state()?;
    if let Some(waiting) = waiting_for_input(&state, &mut std::io::stderr()) {
        return waiting;
    }
    let result = turn.wait(AgentWaitOptionsCore::default()).await?;
    if format == StreamFormat::Json {
        writeln!(stdout, "{}", records::result(&result))?;
    }
    outcome(&result)
}

/// A turn waiting for input cannot be answered through `send`: write its
/// pending requests to `err` and fail; any other state returns `None`.
fn waiting_for_input(state: &AgentTurnState, err: &mut impl Write) -> Option<Result<()>> {
    if state.status != AgentTurnStatus::WaitingInput {
        return None;
    }
    let written = writeln!(err, "{}", records::requests(&state.requests));
    Some(written.map_err(anyhow::Error::from).and_then(|()| {
        Err(anyhow!(
            "turn {} is waiting for input, which this command cannot answer",
            state.id
        ))
    }))
}

/// Exit 0 only for a completed turn; otherwise name the status and error.
fn outcome(result: &AgentResult) -> Result<()> {
    match result.status {
        AgentTurnStatus::Completed => Ok(()),
        status => Err(anyhow!(
            "turn {} {}: {}",
            result.turn_id,
            records::turn_status(status),
            result.error.as_deref().unwrap_or("no error reported")
        )),
    }
}

/// Print each finished text block and one line per tool call as they arrive.
async fn print_text(mut events: AgentEventStream, out: &mut impl Write) -> Result<()> {
    let mut printer = records::TextPrinter::default();
    while let Some(event) = events.next().await {
        if let Some(line) = printer.line(&event?) {
            writeln!(out, "{line}")?;
            out.flush()?;
        }
    }
    Ok(())
}

/// Print one event per line as it arrives. A stream that ends with an error
/// (the agent-level OpenCode stream always does) still delivers every earlier
/// record before the error reaches stderr.
async fn print_events(mut events: AgentEventStream, out: &mut impl Write) -> Result<()> {
    while let Some(event) = events.next().await {
        writeln!(out, "{}", records::event(&event?))?;
        out.flush()?;
    }
    Ok(())
}

impl AgentCreateOptions {
    fn into_core(self) -> Result<AgentCreateOptionsCore> {
        let cwd = self
            .cwd
            .map(|cwd| {
                cwd.into_os_string()
                    .into_string()
                    .map_err(|cwd| anyhow!("--cwd is not UTF-8: {}", cwd.to_string_lossy()))
            })
            .transpose()?;
        let config = match self.agent_config {
            Some(value) => records::parse_config(value)?,
            None => AgentConfig::default(),
        };
        Ok(AgentCreateOptionsCore {
            cwd,
            config,
            idempotency_key: self.control.idempotency_key,
        })
    }
}

impl AgentSendOptions {
    fn into_core(self) -> AgentSendOptionsCore {
        AgentSendOptionsCore {
            mode: match self.mode {
                SendMode::Queue => AgentSendMode::Queue,
                SendMode::Reject => AgentSendMode::Reject,
            },
            data: self.data,
            idempotency_key: self.control.idempotency_key,
        }
    }
}

impl AgentControlOptions {
    fn into_core(self) -> AgentControlOptionsCore {
        AgentControlOptionsCore {
            idempotency_key: self.idempotency_key,
        }
    }
}
