//! Container user profile resolution for login-style sessions.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use nix::unistd::{Uid, User};

/// OpenSSH substitutes `_PATH_BSHELL` when a passwd entry carries no shell
/// (`session.c`, `do_child`); this is that path on Linux.
const DEFAULT_SHELL: &str = "/bin/sh";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionProfile {
    pub(crate) name: String,
    pub(crate) home_dir: String,
    pub(crate) login_shell: String,
}

/// Resolve the execution UID inside the container's mount namespace.
pub(crate) fn session_profile() -> BoxliteResult<SessionProfile> {
    let uid = Uid::effective();
    let user = User::from_uid(uid).map_err(|error| {
        BoxliteError::Execution(format!(
            "failed to resolve SSH execution UID {uid}: {error}"
        ))
    })?;
    Ok(profile_from_passwd(uid.as_raw(), user.as_ref()))
}

fn profile_from_passwd(uid: u32, user: Option<&User>) -> SessionProfile {
    SessionProfile {
        name: user
            .map(|user| user.name.clone())
            .unwrap_or_else(|| uid.to_string()),
        home_dir: non_empty(user.and_then(|user| user.dir.to_str()))
            .unwrap_or("/")
            .to_string(),
        login_shell: non_empty(user.and_then(|user| user.shell.to_str()))
            .unwrap_or(DEFAULT_SHELL)
            .to_string(),
    }
}

fn non_empty(field: Option<&str>) -> Option<&str> {
    field.filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn user(dir: &str, shell: &str) -> User {
        User {
            name: "app".into(),
            passwd: Default::default(),
            uid: Uid::from_raw(12345),
            gid: nix::unistd::Gid::from_raw(12346),
            gecos: Default::default(),
            dir: dir.into(),
            shell: shell.into(),
        }
    }

    #[test]
    fn configured_passwd_fields_are_used_verbatim() {
        assert_eq!(
            profile_from_passwd(12345, Some(&user("/home/app", "/opt/bin/zsh"))),
            SessionProfile {
                name: "app".into(),
                home_dir: "/home/app".into(),
                login_shell: "/opt/bin/zsh".into(),
            }
        );
    }

    #[test]
    fn a_missing_shell_is_not_substituted() {
        assert_eq!(
            profile_from_passwd(12345, Some(&user("/home/app", "/does/not/exist"))).login_shell,
            "/does/not/exist"
        );
    }

    #[test]
    fn empty_passwd_fields_fall_back() {
        let profile = profile_from_passwd(12345, Some(&user("", "")));
        assert_eq!(profile.name, "app");
        assert_eq!(profile.home_dir, "/");
        assert_eq!(profile.login_shell, "/bin/sh");
    }

    #[test]
    fn an_absent_passwd_entry_falls_back_to_numeric_uid() {
        assert_eq!(
            profile_from_passwd(12345, None),
            SessionProfile {
                name: "12345".into(),
                home_dir: "/".into(),
                login_shell: "/bin/sh".into(),
            }
        );
    }

    #[test]
    fn the_passwd_database_yields_absolute_paths() {
        let profile = session_profile().unwrap();
        assert!(Path::new(&profile.home_dir).is_absolute());
        assert!(Path::new(&profile.login_shell).is_absolute());
    }
}
