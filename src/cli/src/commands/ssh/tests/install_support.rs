use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};

use super::{InstallationTarget, execute_inner};
use crate::cli::{Commands, try_parse_from};
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
    let mut cli = try_parse_from(arguments)?;
    crate::contexts::initialize(&mut cli)?;
    let Commands::Ssh(args) = cli.command else {
        unreachable!("parsed SSH installation");
    };
    let target = InstallationTarget {
        home: user_home.to_path_buf(),
        executable: cli_executable(),
    };
    let code = tokio::time::timeout(
        Duration::from_secs(60),
        execute_inner(&args, &cli.global, Some(target)),
    )
    .await
    .context("SSH installation timed out")??;
    assert_eq!(code, 0);
    Ok(())
}
