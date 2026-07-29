//! Container user profile resolution for login-style sessions.

use nix::unistd::{Uid, User};

/// OpenSSH substitutes `_PATH_BSHELL` when a passwd entry carries no shell
/// (`session.c`, `do_child`); this is that path on Linux.
const DEFAULT_SHELL: &str = "/bin/sh";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RootSessionProfile {
    pub(crate) home_dir: String,
    pub(crate) login_shell: String,
}

/// Resolve root's login profile from the passwd database.
///
/// `getpwuid_r` reads the passwd file of the *calling* process's mount
/// namespace, so this is only meaningful once the container has been entered.
/// It is the same lookup libcontainer uses to seed `HOME` (`utils::get_user_home`).
///
/// The passwd shell is used verbatim and only an absent or empty field falls
/// back to `/bin/sh`, matching OpenSSH. An image carrying no passwd entry for
/// root has no OpenSSH analogue — sshd refuses the login — so the same default
/// stands in rather than failing a session the box exists to serve.
pub(crate) fn root_session_profile() -> RootSessionProfile {
    let root = User::from_uid(Uid::from_raw(0)).ok().flatten();
    profile_from_passwd(
        root.as_ref().and_then(|user| user.dir.to_str()),
        root.as_ref().and_then(|user| user.shell.to_str()),
    )
}

fn profile_from_passwd(dir: Option<&str>, shell: Option<&str>) -> RootSessionProfile {
    RootSessionProfile {
        home_dir: non_empty(dir).unwrap_or("/").to_string(),
        login_shell: non_empty(shell).unwrap_or(DEFAULT_SHELL).to_string(),
    }
}

fn non_empty(field: Option<&str>) -> Option<&str> {
    field.filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn configured_passwd_fields_are_used_verbatim() {
        assert_eq!(
            profile_from_passwd(Some("/home/root"), Some("/opt/bin/zsh")),
            RootSessionProfile {
                home_dir: "/home/root".into(),
                login_shell: "/opt/bin/zsh".into(),
            }
        );
    }

    /// A shell the image does not ship is still used verbatim: OpenSSH execs it
    /// and reports the failure rather than silently choosing another shell.
    #[test]
    fn a_missing_shell_is_not_substituted() {
        assert_eq!(
            profile_from_passwd(Some("/root"), Some("/does/not/exist")).login_shell,
            "/does/not/exist"
        );
    }

    #[test]
    fn empty_passwd_fields_fall_back() {
        assert_eq!(
            profile_from_passwd(Some(""), Some("")),
            RootSessionProfile {
                home_dir: "/".into(),
                login_shell: "/bin/sh".into(),
            }
        );
    }

    #[test]
    fn an_absent_passwd_entry_falls_back() {
        assert_eq!(
            profile_from_passwd(None, None),
            RootSessionProfile {
                home_dir: "/".into(),
                login_shell: "/bin/sh".into(),
            }
        );
    }

    #[test]
    fn the_passwd_database_yields_absolute_paths() {
        let profile = root_session_profile();
        assert!(Path::new(&profile.home_dir).is_absolute());
        assert!(Path::new(&profile.login_shell).is_absolute());
    }
}
