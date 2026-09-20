//! Login-style process setup for SSH shell, exec, and SFTP helpers.

use crate::container::user_profile::{session_profile, SessionProfile};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::ffi::OsString;
use std::os::unix::process::CommandExt as _;
use std::path::Path;
use std::process::Command;

pub(crate) const INTERNAL_SESSION_ARG: &str = "--boxlite-internal-ssh-session";

#[derive(Debug, Eq, PartialEq)]
pub(crate) enum SessionAction {
    Shell,
    Exec(String),
}

pub(crate) fn parse_internal_args(args: &[String]) -> BoxliteResult<SessionAction> {
    match args {
        [mode] if mode == "shell" => Ok(SessionAction::Shell),
        [mode, command] if mode == "exec" => Ok(SessionAction::Exec(command.clone())),
        _ => Err(BoxliteError::Config(
            "internal SSH session workload expects `shell` or `exec <command>`".into(),
        )),
    }
}

/// Run after libcontainer has applied the tenant's namespaces and credentials,
/// which is what makes the passwd lookup resolve inside the container.
pub(crate) fn run_internal(action: SessionAction) -> BoxliteResult<()> {
    let profile = prepare_environment()?;
    enter_home(&profile)?;

    match action {
        SessionAction::Shell => exec_login_shell(&profile),
        SessionAction::Exec(command) => exec_command(&profile, &command),
    }
}

pub(super) fn prepare_environment() -> BoxliteResult<SessionProfile> {
    let profile = session_profile()?;
    std::env::set_var("USER", &profile.name);
    std::env::set_var("LOGNAME", &profile.name);
    std::env::set_var("HOME", &profile.home_dir);
    std::env::set_var("SHELL", &profile.login_shell);
    Ok(profile)
}

pub(super) fn enter_home(profile: &SessionProfile) -> BoxliteResult<()> {
    std::env::set_current_dir(&profile.home_dir).or_else(|home_error| {
        std::env::set_current_dir("/").map_err(|fallback_error| {
            BoxliteError::Execution(format!(
                "failed to enter SSH user home {} ({home_error}) and fallback / ({fallback_error})",
                profile.home_dir
            ))
        })
    })?;
    let effective_home = std::env::current_dir().map_err(|error| {
        BoxliteError::Execution(format!("failed to resolve SSH session home: {error}"))
    })?;
    std::env::set_var("HOME", effective_home);
    Ok(())
}

fn exec_login_shell(profile: &SessionProfile) -> BoxliteResult<()> {
    let shell_name = Path::new(&profile.login_shell)
        .file_name()
        .ok_or_else(|| BoxliteError::Execution("SSH login shell has no basename".into()))?;
    let mut login_argv0 = OsString::from("-");
    login_argv0.push(shell_name);
    // OpenSSH marks a login shell by prefixing argv[0] with `-`. This is the
    // portable login-shell convention and does not assume a passwd shell
    // implements a particular `-l` option.
    let error = Command::new(&profile.login_shell).arg0(login_argv0).exec();
    Err(BoxliteError::Execution(format!(
        "failed to exec SSH login shell {}: {error}",
        profile.login_shell
    )))
}

fn exec_command(profile: &SessionProfile, command: &str) -> BoxliteResult<()> {
    // The SSH payload remains one argv value after `-c`; it is never split or
    // interpolated by the guest bridge before the account shell receives it.
    let error = Command::new(&profile.login_shell)
        .arg("-c")
        .arg(command)
        .exec();
    Err(BoxliteError::Execution(format!(
        "failed to exec SSH command shell {}: {error}",
        profile.login_shell
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_ambiguous_internal_session_arguments() {
        assert!(parse_internal_args(&[]).is_err());
        assert!(parse_internal_args(&["exec".into()]).is_err());
        assert!(parse_internal_args(&["shell".into(), "extra".into()]).is_err());
    }

    #[test]
    fn preserves_exec_command_as_one_argument() {
        let command = "printf '%s' 'spaces ; $(still data)'";
        assert_eq!(
            parse_internal_args(&["exec".into(), command.into()]).unwrap(),
            SessionAction::Exec(command.into())
        );
    }

    #[test]
    fn missing_configured_shell_returns_its_path_in_the_error() {
        let directory = tempfile::tempdir().unwrap();
        let shell = directory
            .path()
            .join("missing-shell")
            .to_str()
            .unwrap()
            .to_owned();
        let profile = SessionProfile {
            name: "app".into(),
            home_dir: "/".into(),
            login_shell: shell.clone(),
        };
        for error in [
            exec_command(&profile, "true").unwrap_err(),
            exec_login_shell(&profile).unwrap_err(),
        ] {
            assert!(error.to_string().contains(&shell));
            assert!(error.to_string().contains("No such file or directory"));
        }
    }
}
