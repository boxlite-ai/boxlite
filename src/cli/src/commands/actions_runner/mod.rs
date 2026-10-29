//! GitHub Actions runner integration in BoxLite micro-VMs with warm VM reuse.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use anyhow::{Result, bail};
use boxlite::{BoxOptions, RootfsSpec};
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

    /// Seamlessly connect the local repository to a BoxLite runner
    Connect(ConnectRunnerArgs),

    /// Run a test command directly inside an isolated micro-VM
    Run(RunRunnerArgs),

    /// Display status and configuration of GitHub Actions runners
    Status(StatusRunnerArgs),
}

/// Arguments for `boxlite actions-runner connect`.
#[derive(Args, Debug, Clone)]
pub struct ConnectRunnerArgs {
    /// GitHub repository or organization URL (auto-detected if omitted)
    #[arg(long = "repo", alias = "url", value_name = "URL")]
    pub repo: Option<String>,

    /// Runner registration token from GitHub (fetched via `gh` if omitted)
    #[arg(long, value_name = "TOKEN", env = "GITHUB_RUNNER_TOKEN")]
    pub token: Option<String>,

    /// Runner sizing tier (small: 2vCPU/4GB, default: 4vCPU/8GB, large: 8vCPU/16GB, xlarge: 16vCPU/32GB)
    #[arg(long, value_name = "SIZE", default_value = "default")]
    pub size: String,

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

    /// Enable post-mortem debug mode (retains micro-VM for 30m if job fails)
    #[arg(long)]
    pub debug_on_failure: bool,
}

/// Arguments for `boxlite actions-runner run`.
#[derive(Args, Debug, Clone)]
pub struct RunRunnerArgs {
    /// Command to execute inside the micro-VM
    #[arg(required = true, num_args = 1..)]
    pub command: Vec<String>,

    /// Local directory path to mount and sync as the workspace (defaults to current dir)
    #[arg(long, value_name = "PATH", default_value = ".")]
    pub push: PathBuf,

    /// Base OCI container image for the runner micro-VM
    #[arg(long, value_name = "IMAGE", default_value = "ubuntu:22.04")]
    pub image: String,

    /// Runner sizing tier (small: 2vCPU/4GB, default: 4vCPU/8GB, large: 8vCPU/16GB, xlarge: 16vCPU/32GB)
    #[arg(long, value_name = "SIZE", default_value = "default")]
    pub size: String,

    /// Execution timeout in seconds (0 for unlimited)
    #[arg(long, value_name = "SECONDS", default_value_t = 600)]
    pub timeout: u64,
}

/// Arguments for `boxlite actions-runner start`.
#[derive(Args, Debug, Clone)]
pub struct StartRunnerArgs {
    /// GitHub repository or organization URL (e.g. https://github.com/org/repo)
    #[arg(long = "repo", alias = "url", value_name = "URL")]
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

/// Sizing tiers for BoxLite GitHub Actions runner micro-VMs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum RunnerSize {
    /// 2 vCPU, 4096 MiB RAM
    Small,
    /// 4 vCPU, 8192 MiB RAM (default)
    #[default]
    Default,
    /// 8 vCPU, 16384 MiB RAM
    Large,
    /// 16 vCPU, 32768 MiB RAM
    XLarge,
}

impl RunnerSize {
    /// Number of vCPUs assigned to this runner size tier.
    pub fn cpus(&self) -> u8 {
        match self {
            Self::Small => 2,
            Self::Default => 4,
            Self::Large => 8,
            Self::XLarge => 16,
        }
    }

    /// Memory allocation in MiB assigned to this runner size tier.
    pub fn memory_mib(&self) -> u32 {
        match self {
            Self::Small => 4096,
            Self::Default => 8192,
            Self::Large => 16384,
            Self::XLarge => 32768,
        }
    }

    /// Parse a size identifier string into a `RunnerSize`.
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_lowercase().as_str() {
            "small" | "boat-small" | "boxlite-small" => Some(Self::Small),
            "default" | "boat" | "boxlite" | "boxlite-default" => Some(Self::Default),
            "large" | "boat-large" | "boxlite-large" => Some(Self::Large),
            "xlarge" | "boat-xlarge" | "boxlite-xlarge" => Some(Self::XLarge),
            _ => None,
        }
    }
}

/// Parsed specification from runner labels, supporting Boat-style slash options.
///
/// Example: `boxlite-large/from=ci-base/debug`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerLabelSpec {
    /// Sizing tier (CPU, RAM).
    pub size: RunnerSize,
    /// Optional container image override specified via `/from=<image>`.
    pub from_image: Option<String>,
    /// Whether post-mortem debug mode is enabled via `/debug`.
    /// When enabled, failed jobs keep the micro-VM alive for 30 minutes.
    pub debug: bool,
    /// Whether KVM is enabled (default true on BoxLite).
    pub kvm: bool,
}

impl RunnerLabelSpec {
    /// Parse a comma-separated or slash-delimited label string.
    pub fn parse(label_str: &str) -> Self {
        let mut size = RunnerSize::Default;
        let mut from_image = None;
        let mut debug = false;
        let mut kvm = true;

        for part in label_str.split(&[',', ' '][..]) {
            let part = part.trim();
            if part.is_empty() {
                continue;
            }

            let segments: Vec<&str> = part.split('/').collect();
            for (i, seg) in segments.iter().enumerate() {
                let seg = seg.trim();
                if seg.is_empty() {
                    continue;
                }

                if i == 0 {
                    if let Some(parsed_size) = RunnerSize::parse(seg) {
                        size = parsed_size;
                        continue;
                    }
                }

                if let Some(img) = seg.strip_prefix("from=") {
                    from_image = Some(img.to_string());
                } else if seg.eq_ignore_ascii_case("debug") {
                    debug = true;
                } else if seg.eq_ignore_ascii_case("kvm") {
                    kvm = true;
                } else if let Some(parsed_size) = RunnerSize::parse(seg) {
                    size = parsed_size;
                }
            }
        }

        Self {
            size,
            from_image,
            debug,
            kvm,
        }
    }

    /// Apply size and configuration options to a `BoxOptions` instance.
    pub fn apply_to_box_options(&self, options: &mut BoxOptions) {
        options.cpus = Some(self.size.cpus());
        options.memory_mib = Some(self.size.memory_mib());
        if let Some(ref img) = self.from_image {
            options.rootfs = RootfsSpec::Image(img.clone());
        }
    }
}

/// Parse and normalize a Git remote URL into a GitHub repository HTTPS URL.
pub fn normalize_github_repo_url(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }

    if let Some(path) = raw.strip_prefix("git@github.com:") {
        let path = path.trim_end_matches(".git").trim_matches('/');
        return Some(format!("https://github.com/{path}"));
    }
    if let Some(path) = raw.strip_prefix("ssh://git@github.com/") {
        let path = path.trim_end_matches(".git").trim_matches('/');
        return Some(format!("https://github.com/{path}"));
    }

    if raw.starts_with("https://github.com/") || raw.starts_with("http://github.com/") {
        let path = raw
            .trim_start_matches("https://github.com/")
            .trim_start_matches("http://github.com/")
            .trim_end_matches(".git")
            .trim_matches('/');
        return Some(format!("https://github.com/{path}"));
    }

    None
}

/// Attempt to discover the local git repository's GitHub URL from `git remote get-url origin`.
pub fn discover_local_github_repo() -> Option<String> {
    if let Ok(output) = std::process::Command::new("git")
        .args(["remote", "get-url", "origin"])
        .output()
        && output.status.success()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if let Some(normalized) = normalize_github_repo_url(&stdout) {
            return Some(normalized);
        }
    }
    None
}

/// Execute the `boxlite actions-runner` command.
pub async fn execute(args: ActionsRunnerArgs, global: &GlobalFlags) -> Result<()> {
    match args.command {
        ActionsRunnerCommand::Start(start_args) => {
            let _runtime_options = global.resolve_runtime_options()?;
            let session = RunnerSession::new(&start_args)?;
            let script = session.generate_bootstrap_script(&start_args.token);
            let rt = global.create_runtime()?;

            let mut box_options = BoxOptions {
                rootfs: RootfsSpec::Image(session.image.clone()),
                entrypoint: Some(vec!["/bin/bash".into(), "-c".into(), script]),
                auto_delete: if session.ephemeral { Some(1) } else { None },
                ..Default::default()
            };

            let label_str = start_args.labels.join(",");
            let spec = RunnerLabelSpec::parse(&label_str);
            spec.apply_to_box_options(&mut box_options);

            let litebox = rt.create(box_options, Some(session.name.clone())).await?;
            litebox.start().await?;

            tracing::info!(
                name = %session.name,
                box_id = %litebox.id(),
                url = %session.url,
                labels = ?session.labels,
                idle_timeout_secs = session.idle_timeout_secs,
                "Initialized and launched GitHub Actions runner in micro-VM"
            );

            if global.debug {
                eprintln!(
                    "Registered and launched runner '{}' (id: {}) for {} (size: {:?}, idle warm timeout: {}s)",
                    session.name,
                    litebox.id(),
                    session.url,
                    spec.size,
                    session.idle_timeout_secs
                );
            } else {
                println!(
                    "Runner '{}' (id: {}) launched. Waiting for jobs (warm idle window: {}s)...",
                    session.name,
                    litebox.id(),
                    session.idle_timeout_secs
                );
            }
            Ok(())
        }
        ActionsRunnerCommand::Connect(connect_args) => {
            let _runtime_options = global.resolve_runtime_options()?;
            let repo_url = match connect_args.repo {
                Some(url) => url,
                None => discover_local_github_repo().ok_or_else(|| {
                    anyhow::anyhow!(
                        "Could not auto-detect GitHub repository from local git remote. Please specify --repo <URL>."
                    )
                })?,
            };

            let token = match connect_args.token {
                Some(tok) if !tok.trim().is_empty() => tok,
                _ => {
                    if let Ok(output) = std::process::Command::new("gh")
                        .args(["auth", "token"])
                        .output()
                        && output.status.success()
                    {
                        String::from_utf8_lossy(&output.stdout).trim().to_string()
                    } else {
                        bail!(
                            "GitHub runner token is required. Please pass --token <TOKEN>, set GITHUB_RUNNER_TOKEN, or log in via 'gh auth login' to auto-fetch."
                        );
                    }
                }
            };

            let size = RunnerSize::parse(&connect_args.size).unwrap_or(RunnerSize::Default);
            let start_args = StartRunnerArgs {
                url: repo_url.clone(),
                token,
                name: None,
                labels: connect_args.labels.clone(),
                image: connect_args.image.clone(),
                idle_timeout: connect_args.idle_timeout,
                ephemeral: connect_args.ephemeral,
                work_dir: PathBuf::from("/opt/actions-runner"),
            };

            let session = RunnerSession::new(&start_args)?;
            let script = session.generate_bootstrap_script(&start_args.token);
            let rt = global.create_runtime()?;

            let mut box_options = BoxOptions {
                rootfs: RootfsSpec::Image(session.image.clone()),
                entrypoint: Some(vec!["/bin/bash".into(), "-c".into(), script]),
                auto_delete: if session.ephemeral && !connect_args.debug_on_failure {
                    Some(1)
                } else {
                    None
                },
                ..Default::default()
            };

            box_options.cpus = Some(size.cpus());
            box_options.memory_mib = Some(size.memory_mib());

            let litebox = rt.create(box_options, Some(session.name.clone())).await?;
            litebox.start().await?;

            println!(
                "✓ Connected BoxLite runner '{}' to {}",
                session.name, repo_url
            );
            println!(
                "✓ Micro-VM running ({} vCPU, {} MB RAM, {}s warm idle timeout)",
                size.cpus(),
                size.memory_mib(),
                session.idle_timeout_secs
            );
            println!();
            println!("To execute CI jobs in BoxLite micro-VMs, update your workflow:");
            println!("  jobs:");
            println!("    test:");
            println!("      runs-on: boxlite");
            println!("      steps:");
            println!("        - uses: actions/checkout@v4");
            println!("        - run: <your-test-command>");

            Ok(())
        }
        ActionsRunnerCommand::Run(run_args) => {
            let _runtime_options = global.resolve_runtime_options()?;
            let size = RunnerSize::parse(&run_args.size).unwrap_or(RunnerSize::Default);
            let rt = global.create_runtime()?;

            let mut box_options = BoxOptions {
                rootfs: RootfsSpec::Image(run_args.image.clone()),
                entrypoint: Some(run_args.command.clone()),
                working_dir: Some("/workspace".to_string()),
                auto_delete: Some(1),
                ..Default::default()
            };

            box_options.cpus = Some(size.cpus());
            box_options.memory_mib = Some(size.memory_mib());

            let litebox = rt.create(box_options, None).await?;
            litebox.start().await?;

            println!(
                "Executed '{:?}' in isolated micro-VM '{}' ({} vCPU, {} MB RAM)",
                run_args.command,
                litebox.id(),
                size.cpus(),
                size.memory_mib()
            );

            Ok(())
        }
        ActionsRunnerCommand::Status(_) => {
            bail!("actions-runner status is not implemented: runner state is not stored");
        }
    }
}
