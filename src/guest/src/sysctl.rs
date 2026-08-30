//! Guest kernel settings that a minimal microVM init does not apply for us.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;

const PROC_SYS_ROOT: &str = "/proc/sys";

struct SysctlSetting {
    name: &'static str,
    relative_path: &'static str,
    value: &'static str,
}

const PROTECTED_LINK_SETTINGS: &[SysctlSetting] = &[
    SysctlSetting {
        name: "fs.protected_hardlinks",
        relative_path: "fs/protected_hardlinks",
        value: "1",
    },
    SysctlSetting {
        name: "fs.protected_symlinks",
        relative_path: "fs/protected_symlinks",
        value: "1",
    },
];

/// Apply the security-critical sysctls expected on every BoxLite guest kernel.
pub(crate) fn apply_boot_hardening() -> BoxliteResult<()> {
    apply_boot_hardening_at(Path::new(PROC_SYS_ROOT))
}

fn apply_boot_hardening_at(proc_sys_root: &Path) -> BoxliteResult<()> {
    for setting in PROTECTED_LINK_SETTINGS {
        write_setting(proc_sys_root, setting)?;
    }
    Ok(())
}

fn write_setting(proc_sys_root: &Path, setting: &SysctlSetting) -> BoxliteResult<()> {
    let path = proc_sys_root.join(setting.relative_path);
    let mut file = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|error| {
            BoxliteError::Internal(format!(
                "Failed to set guest sysctl {}={} via {}: {}",
                setting.name,
                setting.value,
                path.display(),
                error
            ))
        })?;
    file.write_all(setting.value.as_bytes()).map_err(|error| {
        BoxliteError::Internal(format!(
            "Failed to set guest sysctl {}={} via {}: {}",
            setting.name,
            setting.value,
            path.display(),
            error
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn boot_hardening_protects_hardlinks_and_symlinks() {
        let proc_sys = tempfile::tempdir().expect("create fake /proc/sys");
        for relative_path in ["fs/protected_hardlinks", "fs/protected_symlinks"] {
            let path = proc_sys.path().join(relative_path);
            fs::create_dir_all(path.parent().expect("sysctl has a parent"))
                .expect("create fake sysctl directory");
            fs::write(path, "0").expect("seed disabled sysctl");
        }

        apply_boot_hardening_at(proc_sys.path()).expect("apply boot hardening");

        for relative_path in ["fs/protected_hardlinks", "fs/protected_symlinks"] {
            let value = fs::read_to_string(proc_sys.path().join(relative_path))
                .expect("read hardened sysctl");
            assert_eq!(value, "1", "{relative_path} must be enabled");
        }
    }

    #[test]
    fn boot_hardening_reports_the_missing_sysctl() {
        let proc_sys = tempfile::tempdir().expect("create fake /proc/sys");

        let error = apply_boot_hardening_at(proc_sys.path())
            .expect_err("missing protected-link sysctls must fail closed");

        assert!(
            error.to_string().contains("fs.protected_hardlinks=1"),
            "error should identify the sysctl that could not be applied: {error}"
        );
    }
}
