//! CLI definition and argument parsing for boxlite-cli.
//! This module contains all CLI-related code including the main CLI structure,
//! subcommands, and flag definitions.

use boxlite::{BoxCommand, BoxOptions, BoxliteOptions, BoxliteRuntime};
use clap::{Args, Parser, Subcommand};
use std::io::IsTerminal;

/// Helper to parse CLI environment variables and apply them to BoxOptions
pub fn apply_env_vars(env: &[String], opts: &mut BoxOptions) {
    apply_env_vars_with_lookup(env, opts, |k| std::env::var(k).ok())
}

/// Helper to parse CLI environment variables with custom lookup for host variables
pub fn apply_env_vars_with_lookup<F>(env: &[String], opts: &mut BoxOptions, lookup: F)
where
    F: Fn(&str) -> Option<String>,
{
    for env_str in env {
        if let Some((k, v)) = env_str.split_once('=') {
            opts.env.push((k.to_string(), v.to_string()));
        } else if let Some(val) = lookup(env_str) {
            opts.env.push((env_str.to_string(), val));
        } else {
            tracing::warn!(
                "Environment variable '{}' not found on host, skipping",
                env_str
            );
        }
    }
}

// ============================================================================
// CLI Definition
// ============================================================================

#[derive(Parser, Debug)]
#[command(name = "boxlite", author, version, about = "BoxLite CLI")]
pub struct Cli {
    #[command(flatten)]
    pub global: GlobalFlags,

    #[command(subcommand)]
    pub command: Commands,
}

#[derive(Subcommand, Debug)]
#[non_exhaustive]
pub enum Commands {
    Run(crate::commands::run::RunArgs),
    /// Execute a command in a running box
    Exec(crate::commands::exec::ExecArgs),
    /// Create a new box
    Create(crate::commands::create::CreateArgs),

    /// List boxes
    #[command(visible_alias = "ls", visible_alias = "ps")]
    List(crate::commands::list::ListArgs),

    /// Remove one or more boxes
    Rm(crate::commands::rm::RmArgs),

    /// Start one or more stopped boxes
    Start(crate::commands::start::StartArgs),

    /// Stop one or more running boxes
    Stop(crate::commands::stop::StopArgs),

    /// Restart one or more boxes
    Restart(crate::commands::restart::RestartArgs),

    /// Pull an image from a registry
    Pull(crate::commands::pull::PullArgs),

    /// List images
    Images(crate::commands::images::ImagesArgs),

    /// Copy files/folders between host and box
    Cp(crate::commands::cp::CpArgs),
}

// ============================================================================
// GLOBAL FLAGS
// ============================================================================

#[derive(Args, Debug, Clone)]
pub struct GlobalFlags {
    /// Enable debug output
    #[arg(long, global = true)]
    pub debug: bool,

    /// BoxLite home directory
    #[arg(long, global = true, env = "BOXLITE_HOME")]
    pub home: Option<std::path::PathBuf>,
}

impl GlobalFlags {
    pub fn create_runtime(&self) -> anyhow::Result<BoxliteRuntime> {
        let options = if let Some(home) = &self.home {
            BoxliteOptions {
                home_dir: home.clone(),
                image_registries: vec![],
            }
        } else {
            BoxliteOptions::default()
        };

        BoxliteRuntime::new(options).map_err(Into::into)
    }
}

// ============================================================================
// PROCESS FLAGS
// ============================================================================

#[derive(Args, Debug, Clone)]
pub struct ProcessFlags {
    /// Keep STDIN open even if not attached
    #[arg(short, long)]
    pub interactive: bool,

    /// Allocate a pseudo-TTY (stdout and stderr are merged in TTY mode)
    #[arg(short, long)]
    pub tty: bool,

    /// Set environment variables
    #[arg(short = 'e', long = "env")]
    pub env: Vec<String>,

    /// Working directory inside the box
    #[arg(short = 'w', long = "workdir")]
    pub workdir: Option<String>,
}

impl ProcessFlags {
    /// Apply process configuration to BoxOptions
    pub fn apply_to(&self, opts: &mut BoxOptions) -> anyhow::Result<()> {
        self.apply_to_with_lookup(opts, |k| std::env::var(k).ok())
    }

    /// Internal helper for dependency injection of environment variables
    fn apply_to_with_lookup<F>(&self, opts: &mut BoxOptions, lookup: F) -> anyhow::Result<()>
    where
        F: Fn(&str) -> Option<String>,
    {
        opts.working_dir = self.workdir.clone();
        apply_env_vars_with_lookup(&self.env, opts, lookup);
        Ok(())
    }

    /// Validate process flags
    pub fn validate(&self, detach: bool) -> anyhow::Result<()> {
        // Check TTY mode only in non-detach mode
        if !detach && self.tty && !std::io::stdin().is_terminal() {
            anyhow::bail!("the input device is not a TTY.");
        }

        Ok(())
    }

    /// Configures a BoxCommand with process flags (env, workdir, tty)
    pub fn configure_command(&self, mut cmd: BoxCommand) -> BoxCommand {
        for env_str in &self.env {
            if let Some((k, v)) = env_str.split_once('=') {
                cmd = cmd.env(k, v);
            } else if let Ok(val) = std::env::var(env_str) {
                cmd = cmd.env(env_str, val);
            }
        }

        if let Some(ref w) = self.workdir {
            cmd = cmd.working_dir(w);
        }

        if self.tty {
            cmd = cmd.tty(true);
        }

        cmd
    }
}

// ============================================================================
// RESOURCE FLAGS
// ============================================================================

#[derive(Args, Debug, Clone)]
pub struct ResourceFlags {
    /// Number of CPUs
    #[arg(long)]
    pub cpus: Option<u32>,

    /// Memory limit (in MiB)
    #[arg(long)]
    pub memory: Option<u32>,
}

impl ResourceFlags {
    pub fn apply_to(&self, opts: &mut BoxOptions) {
        if let Some(cpus) = self.cpus {
            if cpus > 255 {
                tracing::warn!("CPU limit capped at 255 (requested {})", cpus);
            }
            opts.cpus = Some(cpus.min(255) as u8);
        }
        if let Some(mem) = self.memory {
            opts.memory_mib = Some(mem);
        }
    }
}

// ============================================================================
// MANAGEMENT FLAGS
// ============================================================================

#[derive(Args, Debug, Clone)]
pub struct ManagementFlags {
    /// Assign a name to the box
    #[arg(long)]
    pub name: Option<String>,

    /// Run the box in the background (detach)
    #[arg(short = 'd', long)]
    pub detach: bool,

    /// Automatically remove the box when it exits
    #[arg(long)]
    pub rm: bool,
}

impl ManagementFlags {
    pub fn apply_to(&self, opts: &mut BoxOptions) {
        opts.detach = self.detach;
        opts.auto_remove = self.rm;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_apply_env_vars_with_lookup() {
        let mut opts = BoxOptions::default();
        let current_env = vec![
            "TEST_VAR=test_value".to_string(),
            "TEST_HOST_VAR".to_string(),
            "NON_EXISTENT_VAR".to_string(),
        ];

        apply_env_vars_with_lookup(&current_env, &mut opts, |k| {
            if k == "TEST_HOST_VAR" {
                Some("host_value".to_string())
            } else {
                None
            }
        });

        assert!(
            opts.env
                .contains(&("TEST_VAR".to_string(), "test_value".to_string()))
        );

        assert!(
            opts.env
                .contains(&("TEST_HOST_VAR".to_string(), "host_value".to_string()))
        );

        assert!(!opts.env.iter().any(|(k, _)| k == "NON_EXISTENT_VAR"));
    }
}
