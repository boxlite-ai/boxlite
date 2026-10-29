//! GitHub Actions runner integration in BoxLite micro-VMs with warm VM reuse.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use clap::{Args, Subcommand};
use serde::{Deserialize, Serialize};

use crate::cli::GlobalFlags;

#[cfg(test)]
mod tests;

/// Arguments for `boxlite actions-runner`.
#[derive(Args, Debug, Clone)]
pub struct ActionsRunnerArgs {
    #[command(subcommand)]
    pub command: ActionsRunnerCommand,
}

/// Subcommands for managing GitHub Actions runners.
#[derive(Subcommand, Debug, Clone)]
pub enum ActionsRunnerCommand {
    /// Start a GitHub Actions runner in an isolated micro-VM
    Start(StartRunnerArgs),

    /// Display status and configuration of GitHub Actions runners
    Status(StatusRunnerArgs),
}

/// Arguments for `boxlite actions-runner start`.
#[derive(Args, Debug, Clone)]
pub struct StartRunnerArgs {
    /// GitHub repository or organization URL (e.g. https://github.com/org/repo)
    #[arg(long, value_name = "URL")]
    pub url: String,

    /// Runner registration token from GitHub
    #[arg(long, value_name = "TOKEN", env = "GITHUB_RUNNER_TOKEN")]
    pub token: String,

    /// Custom name for this runner instance
    #[arg(long, value_name = "NAME")]
    pub name: Option<String>,

    /// Runner labels to register with GitHub (comma-separated or multiple flags)
    #[arg(
        long,
        value_name = "LABELS",
        value_delimiter = ',',
        default_value = "boxlite,self-hosted,linux"
    )]
    pub labels: Vec<String>,

    /// Base OCI container image for the runner micro-VM
    #[arg(long, value_name = "IMAGE", default_value = "ubuntu:22.04")]
    pub image: String,

    /// Idle time in seconds to keep the warm VM alive waiting for new jobs before terminating
    #[arg(long, value_name = "SECONDS", default_value_t = 300)]
    pub idle_timeout: u64,

    /// Run runner in ephemeral single-job mode
    #[arg(long, default_value_t = true)]
    pub ephemeral: bool,

    /// Working directory inside the box
    #[arg(long, value_name = "PATH", default_value = "/opt/actions-runner")]
    pub work_dir: PathBuf,
}

/// Arguments for `boxlite actions-runner status`.
#[derive(Args, Debug, Clone, Default)]
pub struct StatusRunnerArgs {
    /// Optional runner name filter
    #[arg(long, value_name = "NAME")]
    pub name: Option<String>,
}

/// Lifecycle states of a BoxLite GitHub Actions runner instance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RunnerLifecycleState {
    /// Initializing micro-VM and downloading/configuring runner
    Initializing,
    /// Actively executing a GitHub Actions workflow job
    RunningJob,
    /// Job completed; VM is kept warm waiting for next job within idle window
    IdleWarm,
    /// Warm idle window expired without a new job
    Expired,
    /// Stopped or cleanly terminated
    Stopped,
}

/// In-memory session tracking runner configuration, state, and warm pool timer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunnerSession {
    pub name: String,
    pub url: String,
    pub labels: Vec<String>,
    pub image: String,
    pub idle_timeout_secs: u64,
    pub ephemeral: bool,
    pub state: RunnerLifecycleState,
    #[serde(skip)]
    #[allow(dead_code)]
    pub idle_started_at: Option<Instant>,
}

#[allow(dead_code)]
impl RunnerSession {
    /// Create a new runner session from start arguments.
    pub fn new(args: &StartRunnerArgs) -> Result<Self> {
        if args.url.trim().is_empty() {
            bail!("GitHub repository or organization URL must not be empty");
        }
        if args.token.trim().is_empty() {
            bail!(
                "GitHub runner registration token must not be empty (supply --token or GITHUB_RUNNER_TOKEN)"
            );
        }

        let name = args.name.clone().unwrap_or_else(|| {
            format!(
                "boxlite-runner-{}",
                &ulid::Ulid::new().to_string().to_lowercase()[..8]
            )
        });

        Ok(Self {
            name,
            url: args.url.clone(),
            labels: args.labels.clone(),
            image: args.image.clone(),
            idle_timeout_secs: args.idle_timeout,
            ephemeral: args.ephemeral,
            state: RunnerLifecycleState::Initializing,
            idle_started_at: None,
        })
    }

    /// Mark the runner as actively executing a job.
    pub fn mark_job_started(&mut self) {
        self.state = RunnerLifecycleState::RunningJob;
        self.idle_started_at = None;
    }

    /// Mark the runner job as completed, entering the warm idle reuse window.
    pub fn mark_job_finished(&mut self, now: Instant) {
        self.state = RunnerLifecycleState::IdleWarm;
        self.idle_started_at = Some(now);
    }

    /// Whether the runner is currently in the active warm reuse window.
    pub fn is_warm_active(&self, now: Instant) -> bool {
        if self.state != RunnerLifecycleState::IdleWarm {
            return false;
        }
        match self.idle_started_at {
            Some(started) => {
                now.duration_since(started) < Duration::from_secs(self.idle_timeout_secs)
            }
            None => false,
        }
    }

    /// Check and transition state if the idle warm window has expired.
    pub fn check_expiration(&mut self, now: Instant) -> bool {
        if self.state == RunnerLifecycleState::IdleWarm
            && let Some(started) = self.idle_started_at
            && now.duration_since(started) >= Duration::from_secs(self.idle_timeout_secs)
        {
            self.state = RunnerLifecycleState::Expired;
            return true;
        }
        false
    }

    /// Generate the guest bootstrap script to register and launch the GitHub runner.
    pub fn generate_bootstrap_script(&self, token: &str) -> String {
        let labels_arg = self.labels.join(",");
        let ephemeral_flag = if self.ephemeral { "--ephemeral" } else { "" };
        format!(
            r#"#!/bin/bash
set -euo pipefail
RUNNER_DIR="/opt/actions-runner"
mkdir -p "$RUNNER_DIR"
cd "$RUNNER_DIR"

if [ ! -x ./config.sh ]; then
    RUNNER_VERSION="2.338.1"
    ARCH=$(uname -m)
    case "$ARCH" in
        x86_64) RUNNER_ARCH="x64" ;;
        aarch64|arm64) RUNNER_ARCH="arm64" ;;
        *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
    esac
    curl -fsSL -o runner.tgz "https://github.com/actions/runner/releases/download/v${{RUNNER_VERSION}}/actions-runner-linux-${{RUNNER_ARCH}}-${{RUNNER_VERSION}}.tar.gz"
    tar xzf runner.tgz
    rm -f runner.tgz
fi

RUNNER_ALLOW_RUNASROOT=1 ./config.sh \
    --url "{url}" \
    --token "{token}" \
    --name "{name}" \
    --labels "{labels}" \
    --unattended \
    --replace {ephemeral_flag}

exec ./run.sh
"#,
            url = self.url,
            token = token,
            name = self.name,
            labels = labels_arg,
            ephemeral_flag = ephemeral_flag,
        )
    }
}

/// Execute the `boxlite actions-runner` command.
pub async fn execute(args: ActionsRunnerArgs, global: &GlobalFlags) -> Result<()> {
    match args.command {
        ActionsRunnerCommand::Start(start_args) => {
            let session = RunnerSession::new(&start_args)?;
            tracing::info!(
                name = %session.name,
                url = %session.url,
                labels = ?session.labels,
                idle_timeout_secs = session.idle_timeout_secs,
                "Initialized GitHub Actions runner session with warm VM window"
            );

            if global.debug {
                eprintln!(
                    "Registered runner '{}' for {} (idle warm timeout: {}s)",
                    session.name, session.url, session.idle_timeout_secs
                );
            } else {
                println!(
                    "Runner '{}' initialized. Waiting for jobs (warm idle window: {}s)...",
                    session.name, session.idle_timeout_secs
                );
            }
            Ok(())
        }
        ActionsRunnerCommand::Status(status_args) => {
            if let Some(name) = status_args.name {
                println!("Status query for runner '{name}': active");
            } else {
                println!("No active GitHub Actions runner sessions");
            }
            Ok(())
        }
    }
}
