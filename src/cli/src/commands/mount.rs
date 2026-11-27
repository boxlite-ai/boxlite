use std::io::Write;
use std::path::PathBuf;

use boxlite::{BoxliteError, MountInfo, MountRequest, experimental::ExperimentalFeature};
use clap::{Args, Subcommand};
use tabled::Tabled;

use crate::cli::GlobalFlags;
use crate::formatter::{self, OutputFormat};

#[derive(Args, Debug)]
pub struct MountArgs {
    #[command(subcommand)]
    command: MountCommand,
}

#[derive(Subcommand, Debug)]
enum MountCommand {
    /// Add a host directory to a box
    ///
    /// A running box mounts the directory after guest confirmation. A stopped
    /// box stays stopped and saves a `configured` declaration for its next start.
    Add {
        /// Box ID or name
        #[arg(value_name = "BOX")]
        box_id: String,
        /// Host directory to deliver
        ///
        /// It must exist when added and whenever the box starts. With `--url`,
        /// this is a directory on the server host.
        #[arg(long, value_name = "HOST_DIR")]
        source: PathBuf,
        /// Absolute container path to mount the directory at
        #[arg(long, value_name = "CONTAINER_PATH")]
        box_path: PathBuf,
        /// Deny writes from the box
        #[arg(long)]
        read_only: bool,
    },
    /// Remove the directory mounted at a container path
    ///
    /// A running box detaches it lazily, preserving open files. A stopped box
    /// only drops the declaration; later starts do not deliver it again.
    Rm {
        /// Box ID or name
        #[arg(value_name = "BOX")]
        box_id: String,
        /// Container path of the mount to remove
        #[arg(long, value_name = "CONTAINER_PATH")]
        box_path: PathBuf,
    },
    /// List the directory mounts of a box
    ///
    /// `configured` is saved for the next start. `preparing`, `mounted` and
    /// `detaching` are the last committed progress of the current run;
    /// `mounted` means the guest confirmed the mount. Does not start the box.
    Ls {
        /// Box ID or name
        #[arg(value_name = "BOX")]
        box_id: String,
        #[arg(long, value_enum, default_value = "table")]
        format: OutputFormat,
    },
    /// Show the directory mounted at a container path
    ///
    /// A target without a mount prints `null` as JSON. A stopped box reports
    /// the declaration of its next start and is not started.
    Inspect {
        /// Box ID or name
        #[arg(value_name = "BOX")]
        box_id: String,
        /// Container path of the mount to show
        #[arg(long, value_name = "CONTAINER_PATH")]
        box_path: PathBuf,
        #[arg(long, value_enum, default_value = "table")]
        format: OutputFormat,
    },
}

#[derive(Tabled)]
struct MountRow<'a> {
    #[tabled(rename = "SOURCE")]
    source: std::path::Display<'a>,
    #[tabled(rename = "TARGET")]
    target: std::path::Display<'a>,
    #[tabled(rename = "MODE")]
    mode: &'static str,
    #[tabled(rename = "STATE")]
    state: boxlite::MountState,
}

impl<'a> From<&'a MountInfo> for MountRow<'a> {
    fn from(info: &'a MountInfo) -> Self {
        Self {
            source: info.source.display(),
            target: info.target.display(),
            mode: if info.read_only { "ro" } else { "rw" },
            state: info.state,
        }
    }
}

fn print_mounts<'a, T>(value: &'a T, format: OutputFormat) -> anyhow::Result<()>
where
    T: serde::Serialize,
    &'a T: IntoIterator<Item = &'a MountInfo>,
{
    formatter::print_output(&mut std::io::stdout().lock(), value, format, |writer, _| {
        let table = formatter::create_table(value.into_iter().map(MountRow::from));
        writeln!(writer, "{table}")?;
        Ok(())
    })
}

pub async fn execute(args: MountArgs, global: &GlobalFlags) -> anyhow::Result<()> {
    global
        .experimental_features()
        .require(ExperimentalFeature::NativeVmm)?;
    let box_id = match &args.command {
        MountCommand::Add { box_id, .. }
        | MountCommand::Rm { box_id, .. }
        | MountCommand::Ls { box_id, .. }
        | MountCommand::Inspect { box_id, .. } => box_id,
    };
    let runtime = global.create_runtime()?;
    let handle = runtime
        .get(box_id)
        .await?
        .ok_or_else(|| BoxliteError::NotFound(format!("box {box_id}")))?;
    let mount = handle.mount();
    match args.command {
        MountCommand::Add {
            source,
            box_path,
            read_only,
            ..
        } => {
            let info = mount
                .add(MountRequest {
                    source,
                    target: box_path,
                    read_only,
                })
                .await?;
            print_mounts(&Some(info), OutputFormat::Table)
        }
        MountCommand::Rm { box_path, .. } => Ok(mount.remove(box_path).await?),
        MountCommand::Ls { format, .. } => print_mounts(&mount.list().await?, format),
        MountCommand::Inspect {
            box_path, format, ..
        } => print_mounts(&mount.get(box_path).await?, format),
    }
}

#[cfg(test)]
mod tests {
    use assert_cmd::Command;
    use predicates::prelude::PredicateBooleanExt;
    use predicates::str::contains;

    #[test]
    fn runtime_mount_command_is_hidden_until_opted_in() {
        let cli = crate::ssh_cloud_fixture::cli_executable();
        Command::new(&cli)
            .env_remove("BOXLITE_EXPERIMENTAL")
            .arg("--help")
            .assert()
            .success()
            .stdout(contains("runtime directory mounts").not());
        Command::new(&cli)
            .env_remove("BOXLITE_EXPERIMENTAL")
            .args(["mount", "ls", "box"])
            .assert()
            .failure()
            .stderr(contains("BOXLITE_EXPERIMENTAL=native-vmm"));
        Command::new(&cli)
            .env("BOXLITE_EXPERIMENTAL", "native-vmm")
            .arg("--help")
            .assert()
            .success()
            .stdout(contains("runtime directory mounts"));
        for (features, visible) in [(None, false), (Some("native-vmm"), true)] {
            let mut command = Command::new(&cli);
            match features {
                Some(value) => command.env("BOXLITE_EXPERIMENTAL", value),
                None => command.env_remove("BOXLITE_EXPERIMENTAL"),
            };
            let output = command.args(["completion", "bash"]).output().unwrap();
            assert!(output.status.success());
            let completion = String::from_utf8(output.stdout).unwrap();
            assert_eq!(completion.contains("boxlite,mount)"), visible);
        }
    }
}
