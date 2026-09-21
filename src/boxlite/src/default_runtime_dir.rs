use std::path::{Path, PathBuf};

/// Compile-time fallback for debug builds that skip `include_bytes!`.
///
/// In-tree CLI/tests use the stable `target/<profile>/runtime` symlink tree.
/// crates.io and other dependency builds extract under `OUT_DIR/runtime`.
pub(crate) fn default_runtime_dir(
    is_dependency_build: bool,
    workspace_target_dir: Option<&Path>,
    out_runtime_dir: &Path,
    profile: &str,
) -> PathBuf {
    if is_dependency_build {
        return out_runtime_dir.to_path_buf();
    }
    match workspace_target_dir {
        Some(target_dir) => target_dir.join(profile).join("runtime"),
        None => out_runtime_dir.to_path_buf(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out_runtime() -> PathBuf {
        PathBuf::from("/consumer/target/debug/build/boxlite-0/out/runtime")
    }

    fn workspace_target() -> PathBuf {
        PathBuf::from("/repo/target")
    }

    #[test]
    fn in_tree_debug_uses_stable_workspace_runtime() {
        let dir = default_runtime_dir(
            false,
            Some(workspace_target().as_path()),
            &out_runtime(),
            "debug",
        );
        assert_eq!(dir, PathBuf::from("/repo/target/debug/runtime"));
    }

    #[test]
    fn crates_io_dependency_build_uses_out_dir_runtime() {
        let dir = default_runtime_dir(true, None, &out_runtime(), "debug");
        assert_eq!(dir, out_runtime());
    }

    #[test]
    fn git_dependency_with_workspace_still_uses_out_dir_runtime() {
        let dir = default_runtime_dir(
            true,
            Some(workspace_target().as_path()),
            &out_runtime(),
            "debug",
        );
        assert_eq!(dir, out_runtime());
    }

    #[test]
    fn packaged_crate_as_primary_without_workspace_uses_out_dir_runtime() {
        let dir = default_runtime_dir(false, None, &out_runtime(), "debug");
        assert_eq!(dir, out_runtime());
    }
}
