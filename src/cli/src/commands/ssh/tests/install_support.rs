use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};
use clap::FromArgMatches;

use super::{ConnectionTarget, InstallationTarget, execute_inner};
use crate::cli::{Cli, Commands, command};
use crate::ssh_cloud_fixture::cli_executable;

pub(super) async fn install(home: &Path, user_home: &Path, flags: &[&str]) -> Result<()> {
    let mut arguments = vec![
        std::ffi::OsString::from("boxlite"),
        "--home".into(),
        home.as_os_str().to_owned(),
        "ssh".into(),
        "dev".into(),
        "--install-ssh-config".into(),
    ];
    arguments.extend(flags.iter().map(|flag| std::ffi::OsString::from(*flag)));
    let matches = without_environment(command()).try_get_matches_from(arguments)?;
    let mut cli = Cli::from_arg_matches(&matches)?;
    crate::contexts::initialize(&mut cli)?;
    let selected = cli
        .global
        .selected_context
        .as_ref()
        .context("installation test context was not initialized")?;
    let connection = ConnectionTarget {
        context: selected.name.clone(),
        rest: cli
            .global
            .resolve_rest_options(selected.profile.clone(), None),
    };
    let Commands::Ssh(args) = cli.command else {
        unreachable!("parsed SSH installation");
    };
    let target = InstallationTarget {
        home: user_home.to_path_buf(),
        executable: cli_executable(),
    };
    let code = tokio::time::timeout(
        Duration::from_secs(60),
        execute_inner(&args, &cli.global, connection, Some(target)),
    )
    .await
    .context("SSH installation timed out")??;
    assert_eq!(code, 0);
    Ok(())
}

/// Use the real argument schema without consulting process-global settings.
fn without_environment(command: clap::Command) -> clap::Command {
    command
        .mut_args(|argument| argument.env(None::<&str>))
        .mut_subcommands(without_environment)
}
