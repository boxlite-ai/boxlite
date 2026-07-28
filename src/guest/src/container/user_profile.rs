//! Container user profile resolution for login-style sessions.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::fs;
use std::io::Read as _;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Component, Path, PathBuf};

const MAX_PASSWD_BYTES: u64 = 1024 * 1024;
const FALLBACK_SHELLS: [&str; 6] = [
    "/bin/bash",
    "/bin/ash",
    "/bin/sh",
    "/usr/bin/bash",
    "/usr/bin/ash",
    "/usr/bin/sh",
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RootSessionProfile {
    pub(crate) home_dir: String,
    pub(crate) login_shell: String,
}

/// Resolve root's login profile relative to a container root filesystem.
///
/// Both returned values are container paths. A missing, malformed, or unusable
/// passwd home falls back to `/`; an unusable passwd shell falls through a
/// fixed list of common absolute shell paths. Resolution never follows a
/// container symlink outside `rootfs` in the guest mount namespace.
pub(crate) fn root_session_profile(rootfs: &Path) -> RootSessionProfile {
    let passwd = read_passwd(rootfs);
    let configured = passwd.as_deref().and_then(root_fields);
    let home_dir = configured
        .and_then(|(home, _)| usable_directory(rootfs, home).then_some(home))
        .unwrap_or("/")
        .to_string();
    let login_shell = configured
        .and_then(|(_, shell)| usable_executable(rootfs, shell).then_some(shell))
        .or_else(|| {
            FALLBACK_SHELLS
                .into_iter()
                .find(|shell| usable_executable(rootfs, shell))
        })
        // Preserve the conventional failure mode when an image has no shell:
        // exec reports `/bin/sh` missing instead of inventing a guest path.
        .unwrap_or("/bin/sh")
        .to_string();

    RootSessionProfile {
        home_dir,
        login_shell,
    }
}

fn read_passwd(rootfs: &Path) -> Option<String> {
    let passwd = safely_resolved(rootfs, "/etc/passwd")?;
    let mut file = fs::File::open(passwd).ok()?;
    let mut bytes = Vec::new();
    file.by_ref()
        .take(MAX_PASSWD_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_PASSWD_BYTES {
        return None;
    }
    String::from_utf8(bytes).ok()
}

fn root_fields(passwd: &str) -> Option<(&str, &str)> {
    passwd.lines().find_map(|line| {
        let mut fields = line.split(':');
        let name = fields.next()?;
        let _password = fields.next()?;
        let _uid = fields.next()?;
        let _gid = fields.next()?;
        let _gecos = fields.next()?;
        let home = fields.next()?;
        let shell = fields.next()?;
        (name == "root").then_some((home, shell))
    })
}

fn usable_directory(rootfs: &Path, container_path: &str) -> bool {
    safely_resolved(rootfs, container_path).is_some_and(|path| path.is_dir())
}

fn usable_executable(rootfs: &Path, container_path: &str) -> bool {
    safely_resolved(rootfs, container_path).is_some_and(|path| {
        fs::metadata(path)
            .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
    })
}

fn safely_resolved(rootfs: &Path, container_path: &str) -> Option<PathBuf> {
    let container_path = Path::new(container_path);
    if !container_path.is_absolute()
        || container_path
            .components()
            .any(|component| !matches!(component, Component::RootDir | Component::Normal(_)))
    {
        return None;
    }
    let rootfs = fs::canonicalize(rootfs).ok()?;
    let mut pending = owned_components(container_path.strip_prefix("/").ok()?);
    let mut relative = PathBuf::new();
    let mut followed_symlinks = 0_u8;

    while let Some(component) = pending.pop_front() {
        match component {
            OwnedComponent::Current => {}
            OwnedComponent::Parent => {
                // A chroot clamps `..` at its root; mirror that behavior while
                // resolving against the guest-visible rootfs tree.
                relative.pop();
            }
            OwnedComponent::Normal(name) => {
                let candidate = rootfs.join(&relative).join(&name);
                let metadata = fs::symlink_metadata(&candidate).ok()?;
                if metadata.file_type().is_symlink() {
                    followed_symlinks = followed_symlinks.checked_add(1)?;
                    if followed_symlinks > 40 {
                        return None;
                    }
                    let target = fs::read_link(candidate).ok()?;
                    if target.is_absolute() {
                        relative.clear();
                    }
                    let mut target_components = owned_components(&target);
                    target_components.append(&mut pending);
                    pending = target_components;
                } else {
                    relative.push(name);
                }
            }
        }
    }

    Some(rootfs.join(relative))
}

enum OwnedComponent {
    Current,
    Parent,
    Normal(OsString),
}

fn owned_components(path: &Path) -> VecDeque<OwnedComponent> {
    path.components()
        .filter_map(|component| match component {
            Component::RootDir => None,
            Component::CurDir => Some(OwnedComponent::Current),
            Component::ParentDir => Some(OwnedComponent::Parent),
            Component::Normal(name) => Some(OwnedComponent::Normal(name.to_os_string())),
            Component::Prefix(_) => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_executable(path: &Path) {
        fs::write(path, "#!/bin/sh\n").unwrap();
        let mut permissions = fs::metadata(path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(path, permissions).unwrap();
    }

    #[test]
    fn configured_root_home_and_executable_shell_are_selected() {
        let rootfs = tempfile::tempdir().unwrap();
        fs::create_dir_all(rootfs.path().join("etc")).unwrap();
        fs::create_dir_all(rootfs.path().join("home/root")).unwrap();
        fs::create_dir_all(rootfs.path().join("opt/bin")).unwrap();
        write_executable(&rootfs.path().join("opt/bin/zsh"));
        fs::write(
            rootfs.path().join("etc/passwd"),
            "root:x:0:0:root:/home/root:/opt/bin/zsh\n",
        )
        .unwrap();

        assert_eq!(
            root_session_profile(rootfs.path()),
            RootSessionProfile {
                home_dir: "/home/root".into(),
                login_shell: "/opt/bin/zsh".into(),
            }
        );
    }

    #[test]
    fn missing_home_and_unusable_shell_use_safe_fallbacks() {
        let rootfs = tempfile::tempdir().unwrap();
        fs::create_dir_all(rootfs.path().join("etc")).unwrap();
        fs::create_dir_all(rootfs.path().join("bin")).unwrap();
        write_executable(&rootfs.path().join("bin/ash"));
        fs::write(
            rootfs.path().join("etc/passwd"),
            "root:x:0:0:root:/missing:/missing/shell\n",
        )
        .unwrap();

        assert_eq!(
            root_session_profile(rootfs.path()),
            RootSessionProfile {
                home_dir: "/".into(),
                login_shell: "/bin/ash".into(),
            }
        );
    }

    #[test]
    fn absolute_symlink_cannot_escape_the_container_rootfs() {
        use std::os::unix::fs::symlink;

        let rootfs = tempfile::tempdir().unwrap();
        fs::create_dir_all(rootfs.path().join("etc")).unwrap();
        fs::create_dir_all(rootfs.path().join("bin")).unwrap();
        write_executable(&rootfs.path().join("bin/sh"));
        symlink("/tmp", rootfs.path().join("escape")).unwrap();
        fs::write(
            rootfs.path().join("etc/passwd"),
            "root:x:0:0:root:/escape:/escape/sh\n",
        )
        .unwrap();

        let profile = root_session_profile(rootfs.path());
        assert_eq!(profile.home_dir, "/");
        assert_eq!(profile.login_shell, "/bin/sh");
    }

    #[test]
    fn absolute_shell_symlink_is_resolved_from_the_container_root() {
        use std::os::unix::fs::symlink;

        let rootfs = tempfile::tempdir().unwrap();
        fs::create_dir_all(rootfs.path().join("etc")).unwrap();
        fs::create_dir_all(rootfs.path().join("bin")).unwrap();
        fs::create_dir_all(rootfs.path().join("usr/bin")).unwrap();
        write_executable(&rootfs.path().join("usr/bin/ash"));
        symlink("/usr/bin/ash", rootfs.path().join("bin/sh")).unwrap();
        fs::write(
            rootfs.path().join("etc/passwd"),
            "root:x:0:0:root:/:/bin/sh\n",
        )
        .unwrap();

        assert_eq!(root_session_profile(rootfs.path()).login_shell, "/bin/sh");
    }

    #[test]
    fn symlink_loop_is_rejected_and_uses_a_fallback_shell() {
        use std::os::unix::fs::symlink;

        let rootfs = tempfile::tempdir().unwrap();
        fs::create_dir_all(rootfs.path().join("etc")).unwrap();
        fs::create_dir_all(rootfs.path().join("bin")).unwrap();
        write_executable(&rootfs.path().join("bin/ash"));
        symlink("/loop-b", rootfs.path().join("loop-a")).unwrap();
        symlink("/loop-a", rootfs.path().join("loop-b")).unwrap();
        fs::write(
            rootfs.path().join("etc/passwd"),
            "root:x:0:0:root:/:/loop-a\n",
        )
        .unwrap();

        assert_eq!(root_session_profile(rootfs.path()).login_shell, "/bin/ash");
    }
}
