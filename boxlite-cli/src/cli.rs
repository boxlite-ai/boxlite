//! CLI definition and argument parsing for boxlite-cli.
//! This module contains all CLI-related code including the main CLI structure,
//! subcommands, and flag definitions.

use boxlite::BoxOptions;
use clap::{Args, Parser, Subcommand};

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

    /// Remove one or more boxes
    Rm(crate::commands::rm::RmArgs),
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

        for env_str in &self.env {
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
        Ok(())
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
    /// Automatically remove the boxlite when it exits
    #[arg(long)]
    pub rm: bool,

    /// Run boxlite in background and print boxlite ID
    #[arg(short, long)]
    pub detach: bool,

    /// Assign a name to the box
    #[arg(long)]
    pub name: Option<String>,
}

impl ManagementFlags {
    pub fn apply_to(&self, opts: &mut BoxOptions) {
        opts.auto_remove = self.rm;
        opts.detach = self.detach;
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_process_flags_env_parsing() {
        let flags = ProcessFlags {
            interactive: false,
            tty: false,
            workdir: None,
            env: vec!["KEY=VALUE".to_string(), "EMPTY=".to_string()],
        };

        let mut opts = BoxOptions::default();
        flags.apply_to(&mut opts).unwrap();

        assert!(opts.env.contains(&("KEY".to_string(), "VALUE".to_string())));
        assert!(opts.env.contains(&("EMPTY".to_string(), "".to_string())));
    }

    #[test]
    fn test_process_flags_env_passthrough() {
        let flags = ProcessFlags {
            interactive: false,
            tty: false,
            workdir: None,
            // "TEST_HOST_VAR" -> "host_value"
            // "NON_EXISTENT_VAR" ->  ignored
            env: vec!["TEST_HOST_VAR".to_string(), "NON_EXISTENT_VAR".to_string()],
        };

        let mut opts = BoxOptions::default();

        flags
            .apply_to_with_lookup(&mut opts, |key| match key {
                "TEST_HOST_VAR" => Some("host_value".to_string()),
                _ => None,
            })
            .unwrap();

        assert!(
            opts.env
                .contains(&("TEST_HOST_VAR".to_string(), "host_value".to_string()))
        );

        assert!(!opts.env.iter().any(|(k, _)| k == "NON_EXISTENT_VAR"));
    }

    #[test]
    fn test_resource_flags_cpu_cap() {
        let flags = ResourceFlags {
            cpus: Some(1000),
            memory: None,
        };

        let mut opts = BoxOptions::default();
        flags.apply_to(&mut opts);

        assert_eq!(opts.cpus, Some(255));
    }
}
