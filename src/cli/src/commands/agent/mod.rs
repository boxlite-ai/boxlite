//! P0 agent command declarations; execution is deliberately unimplemented.

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
    /// Create an agent session (not implemented).
    Create {
        #[command(flatten)]
        target: BoxTarget,
        /// Agent identifier
        agent: String,
        #[command(flatten)]
        options: AgentCreateOptions,
    },
    /// Look up a session (not implemented).
    Get(SessionTarget),
    /// Send work, inspect state, and handle session requests (not implemented).
    #[command(subcommand)]
    Session(SessionCommand),
    /// Observe and control one turn (not implemented).
    #[command(subcommand)]
    Turn(TurnCommand),
}

#[derive(Subcommand, Debug)]
pub enum SessionCommand {
    /// Close a session (not implemented).
    Close {
        #[command(flatten)]
        target: SessionTarget,
        #[command(flatten)]
        options: AgentControlOptions,
    },
    /// Submit text and optional JSON data (not implemented).
    Send {
        #[command(flatten)]
        target: SessionTarget,
        /// Message text
        text: String,
        #[command(flatten)]
        options: AgentSendOptions,
    },
    /// Look up a turn without executing it (not implemented).
    GetTurn(TurnTarget),
    /// Open session events after a cursor (not implemented).
    Events {
        #[command(flatten)]
        target: SessionTarget,
        #[command(flatten)]
        options: AgentEventsOptions,
    },
    /// Read outstanding questions and permissions (not implemented).
    Requests(SessionTarget),
    /// Submit an answer or permission response as JSON (not implemented).
    Respond {
        #[command(flatten)]
        target: SessionTarget,
        /// Request identifier
        request: String,
        /// Typed answer or permission response
        #[arg(value_name = "JSON", value_parser = parse_json)]
        response: Value,
        #[command(flatten)]
        options: AgentControlOptions,
    },
    /// Read session state (not implemented).
    State(SessionTarget),
    /// Read effective agent configuration (not implemented).
    Config(SessionTarget),
    /// Read adapter capabilities and limits (not implemented).
    Capabilities(SessionTarget),
}

#[derive(Subcommand, Debug)]
pub enum TurnCommand {
    /// Wait for a turn result (not implemented).
    Wait {
        #[command(flatten)]
        target: TurnTarget,
        #[command(flatten)]
        options: AgentWaitOptions,
    },
    /// Open turn events after a cursor (not implemented).
    Events {
        #[command(flatten)]
        target: TurnTarget,
        #[command(flatten)]
        options: AgentEventsOptions,
    },
    /// Steer this turn without creating another turn (not implemented).
    Steer {
        #[command(flatten)]
        target: TurnTarget,
        /// Steering instructions
        text: String,
        #[command(flatten)]
        options: AgentControlOptions,
    },
    /// Interrupt this turn's agent loop (not implemented).
    Interrupt {
        #[command(flatten)]
        target: TurnTarget,
        #[command(flatten)]
        options: AgentControlOptions,
    },
    /// Read turn state (not implemented).
    State(TurnTarget),
}

#[derive(Args, Debug)]
pub struct BoxTarget {
    /// Box ID or name
    #[arg(value_name = "BOX")]
    target: String,
}

#[derive(Args, Debug)]
pub struct SessionTarget {
    #[command(flatten)]
    sandbox: BoxTarget,
    /// Session identifier
    #[arg(value_name = "SESSION")]
    session: String,
}

#[derive(Args, Debug)]
pub struct TurnTarget {
    #[command(flatten)]
    session: SessionTarget,
    /// Turn identifier
    #[arg(value_name = "TURN")]
    turn: String,
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
    /// Admission mode once implemented
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
    /// Retry key; deduplication is not implemented
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

fn parse_json(input: &str) -> serde_json::Result<Value> {
    serde_json::from_str(input)
}

pub fn execute(args: AgentArgs) -> Result<()> {
    // Do not initialize a runtime or resolve a Box just to reach a stub.
    let operation = match args.command {
        AgentCommand::Create { .. } => "agents.create",
        AgentCommand::Get(_) => "agents.get",
        AgentCommand::Session(command) => match command {
            SessionCommand::Close { .. } => "session.close",
            SessionCommand::Send { .. } => "session.send",
            SessionCommand::GetTurn(_) => "session.get_turn",
            SessionCommand::Events { .. } => "session.events",
            SessionCommand::Requests(_) => "session.requests",
            SessionCommand::Respond { .. } => "session.respond",
            SessionCommand::State(_) => "session.state",
            SessionCommand::Config(_) => "session.config",
            SessionCommand::Capabilities(_) => "session.capabilities",
        },
        AgentCommand::Turn(command) => match command {
            TurnCommand::Wait { .. } => "turn.wait",
            TurnCommand::Events { .. } => "turn.events",
            TurnCommand::Steer { .. } => "turn.steer",
            TurnCommand::Interrupt { .. } => "turn.interrupt",
            TurnCommand::State(_) => "turn.state",
        },
    };
    Err(BoxliteError::Unsupported(format!("{operation} is not implemented")).into())
}
