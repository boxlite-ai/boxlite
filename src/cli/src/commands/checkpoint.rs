//! `pause`, `resume` and `checkpoint export|import` for checkpoint-enabled
//! boxes. Embedded runtime only: these commands accept no server options.

use crate::cli::GlobalFlags;
use boxlite::{BoxliteError, BoxliteRuntime, CheckpointImportOptions, LiteBox, PauseOptions};
use clap::{Args, Subcommand};
use std::path::PathBuf;

/// Pause a checkpoint-enabled box
#[derive(Args, Debug)]
pub struct PauseArgs {
    /// Name or ID of the box
    pub target: String,

    /// Assert that every host process writing the box's volumes is stopped
    /// and stays stopped until `boxlite resume` or `boxlite stop`.
    ///
    /// Required when the box mounts host directories or volumes. The pause
    /// stops the guest, not the host: a writer left running would change a
    /// share under the paused guest and tear any checkpoint taken from it.
    #[arg(long = "host-writers-stopped")]
    pub host_writers_stopped: bool,
}

/// Resume a paused box
#[derive(Args, Debug)]
pub struct ResumeArgs {
    /// Name or ID of the box
    pub target: String,
}

/// Export or import a paused box as a two-file checkpoint directory
#[derive(Args, Debug)]
pub struct CheckpointArgs {
    #[command(subcommand)]
    pub command: CheckpointCommand,
}

#[derive(Subcommand, Debug)]
pub enum CheckpointCommand {
    /// Inspect external dependencies without provisioning or starting a box
    Inspect { path: PathBuf },
    /// Write a paused box's memory, devices and disks to a new two-file directory
    Export(ExportArgs),
    /// Create a new, paused box from a checkpoint directory
    Import(ImportArgs),
}

#[derive(Args, Debug)]
pub struct ExportArgs {
    /// Name or ID of a paused box
    pub target: String,

    /// Checkpoint directory to create; it must not exist yet
    pub path: PathBuf,
}

#[derive(Args, Debug)]
pub struct ImportArgs {
    /// Checkpoint directory written by `boxlite checkpoint export`
    pub path: PathBuf,

    /// Assign a name to the new box
    #[arg(long)]
    pub name: Option<String>,
}

pub async fn pause(args: PauseArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let litebox = find_box(&local_runtime(global)?, &args.target).await?;
    let options = PauseOptions {
        host_writers_stopped: args.host_writers_stopped,
    };
    if let Err(error) = litebox.pause(options).await {
        if !args.host_writers_stopped && matches!(error, BoxliteError::InvalidArgument(_)) {
            anyhow::bail!(
                "{error}\nStop every host process that writes the box's volumes, then rerun \
                 with --host-writers-stopped."
            );
        }
        return Err(error.into());
    }
    println!("{}", args.target);
    if args.host_writers_stopped {
        eprintln!(
            "Keep the box's host writers stopped until `boxlite resume {0}` or \
             `boxlite stop {0}`.",
            args.target
        );
    }
    Ok(())
}

pub async fn resume(args: ResumeArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    let litebox = find_box(&local_runtime(global)?, &args.target).await?;
    litebox.resume().await?;
    println!("{}", args.target);
    Ok(())
}

pub async fn checkpoint(args: CheckpointArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    match args.command {
        CheckpointCommand::Inspect { path } => {
            println!(
                "{}",
                serde_json::to_string_pretty(&BoxliteRuntime::inspect_checkpoint(path)?)?
            );
        }
        CheckpointCommand::Export(args) => {
            let runtime = local_runtime(global)?;
            let path = std::path::absolute(&args.path)?;
            let litebox = find_box(&runtime, &args.target).await?;
            litebox.export_checkpoint(&path).await?;
            println!("{}", path.display());
        }
        CheckpointCommand::Import(args) => {
            let runtime = local_runtime(global)?;
            let path = std::path::absolute(&args.path)?;
            let options = CheckpointImportOptions { name: args.name };
            let litebox = runtime.import_checkpoint(&path, options).await?;
            println!("{}", litebox.id());
        }
    }
    Ok(())
}

/// Checkpoints exist only in the embedded runtime, so a configured server
/// profile is never consulted.
fn local_runtime(global: &GlobalFlags) -> anyhow::Result<BoxliteRuntime> {
    global.create_runtime_with_options(global.resolve_runtime_options()?)
}

async fn find_box(runtime: &BoxliteRuntime, target: &str) -> anyhow::Result<LiteBox> {
    runtime
        .get(target)
        .await?
        .ok_or_else(|| anyhow::anyhow!("No such box: {target}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli::{Cli, Commands, try_parse_from};
    use clap::error::ErrorKind;

    fn parse(args: &[&str]) -> Cli {
        try_parse_from(args).expect("parse")
    }

    #[test]
    fn pause_asserts_no_host_writers_only_when_asked() {
        let Commands::Pause(args) = parse(&["boxlite", "pause", "web"]).command else {
            panic!("expected pause");
        };
        assert_eq!(args.target, "web");
        assert!(!args.host_writers_stopped);

        let Commands::Pause(args) =
            parse(&["boxlite", "pause", "--host-writers-stopped", "web"]).command
        else {
            panic!("expected pause");
        };
        assert!(args.host_writers_stopped);
    }

    #[test]
    fn checkpoint_subcommands_parse_their_operands() {
        let Commands::Checkpoint(CheckpointArgs {
            command: CheckpointCommand::Export(export),
        }) = parse(&["boxlite", "checkpoint", "export", "web", "checkpoint-dir"]).command
        else {
            panic!("expected checkpoint export");
        };
        assert_eq!(export.target, "web");
        assert_eq!(export.path, PathBuf::from("checkpoint-dir"));

        let Commands::Checkpoint(CheckpointArgs {
            command: CheckpointCommand::Import(import),
        }) = parse(&[
            "boxlite",
            "checkpoint",
            "import",
            "--name",
            "web2",
            "web.boxckpt",
        ])
        .command
        else {
            panic!("expected checkpoint import");
        };
        assert_eq!(import.path, PathBuf::from("web.boxckpt"));
        assert_eq!(import.name.as_deref(), Some("web2"));
    }

    #[test]
    fn checkpoint_commands_require_their_operands() {
        for args in [
            &["boxlite", "pause"][..],
            &["boxlite", "resume"][..],
            &["boxlite", "checkpoint", "export", "web"][..],
            &["boxlite", "checkpoint", "import"][..],
        ] {
            let error = try_parse_from(args).expect_err("missing operand must be refused");
            assert_eq!(error.kind(), ErrorKind::MissingRequiredArgument, "{args:?}");
        }
    }

    /// Checkpoints are embedded-runtime only; a server URL or profile on
    /// these commands is a usage error, not something silently ignored.
    #[test]
    fn checkpoint_commands_refuse_server_options() {
        for args in [
            &["boxlite", "pause", "--url", "http://127.0.0.1:1", "web"][..],
            &["boxlite", "resume", "--profile", "prod", "web"][..],
            &[
                "boxlite",
                "checkpoint",
                "export",
                "--url",
                "http://127.0.0.1:1",
                "web",
                "web.boxckpt",
            ][..],
            &[
                "boxlite",
                "checkpoint",
                "import",
                "--profile",
                "prod",
                "web.boxckpt",
            ][..],
        ] {
            let error = try_parse_from(args).expect_err("server option must be refused");
            assert_eq!(error.kind(), ErrorKind::UnknownArgument, "{args:?}");
        }
    }

    #[tokio::test]
    async fn pause_and_resume_report_a_missing_box() {
        let home = tempfile::tempdir().expect("home");
        let home = home.path().join("boxlite");
        let home = home.to_str().expect("utf-8 home");
        let cli = parse(&["boxlite", "--home", home, "pause", "missing"]);
        let Commands::Pause(args) = cli.command else {
            panic!("expected pause");
        };
        let error = pause(args, &cli.global).await.expect_err("no such box");
        assert_eq!(error.to_string(), "No such box: missing");

        let cli = parse(&["boxlite", "--home", home, "resume", "missing"]);
        let Commands::Resume(args) = cli.command else {
            panic!("expected resume");
        };
        let error = resume(args, &cli.global).await.expect_err("no such box");
        assert_eq!(error.to_string(), "No such box: missing");
    }

    /// An import from a file that is not a checkpoint fails and leaves no box.
    #[tokio::test]
    async fn import_of_a_non_checkpoint_creates_no_box() {
        let temp = tempfile::tempdir().expect("temp");
        let file = temp.path().join("not-a-checkpoint");
        std::fs::write(&file, b"plain bytes").expect("write");
        let home = temp.path().join("boxlite");
        let home = home.to_str().expect("utf-8 home");
        let file = file.to_str().expect("utf-8 path");
        let cli = parse(&["boxlite", "--home", home, "checkpoint", "import", file]);
        let Commands::Checkpoint(args) = cli.command else {
            panic!("expected checkpoint");
        };

        checkpoint(args, &cli.global)
            .await
            .expect_err("a non-checkpoint file must be refused");

        let runtime = local_runtime(&cli.global).expect("runtime");
        assert!(runtime.list_info().await.expect("list").is_empty());
    }
}
