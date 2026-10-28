//! Agent instance and turn commands.

use anyhow::Result;
use boxlite::BoxliteError;
use clap::{Args, Subcommand, ValueEnum};
use serde_json::Value;
use std::path::PathBuf;

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
    /// Submit text and optional JSON data.
    Send {
        #[command(flatten)]
        target: AgentTarget,
        /// Message text
        text: String,
        #[command(flatten)]
        options: AgentSendOptions,
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

pub fn execute(args: AgentArgs) -> Result<()> {
    let operation = match args.command {
        AgentCommand::Create { .. } => "agents.create",
        AgentCommand::Close { .. } => "agent.close",
        AgentCommand::Send { .. } => "agent.send",
        AgentCommand::Respond { .. } => "agent.respond",
        AgentCommand::Inspect { target, options } => match options.view {
            Some(AgentView::Config) => "agent.config",
            Some(AgentView::Capabilities) => "agent.capabilities",
            Some(AgentView::Requests) => "agent.requests",
            None if target.turn.is_some() => "turn.state",
            None => "agent.state",
        },
        AgentCommand::Events { target, .. } if target.turn.is_some() => "turn.events",
        AgentCommand::Events { .. } => "agent.events",
        AgentCommand::Wait { .. } => "turn.wait",
        AgentCommand::Steer { .. } => "turn.steer",
        AgentCommand::Interrupt { .. } => "turn.interrupt",
    };
    Err(BoxliteError::Unsupported(format!("{operation} is not implemented")).into())
}
