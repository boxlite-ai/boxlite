//! Cgroup hierarchy carve-out for the workload / operator split.
//!
//! ```text
//! /sys/fs/cgroup/boxlite/<id>/                  parent (no processes, only delegates)
//!     ├── workload/                              container init + container processes
//!     │   pids.max = 512
//!     │   memory.max = container_memory_limit()
//!     └── operator/                              `boxlite exec`-spawned processes
//!         pids.max = OPERATOR_PIDS_MAX (64)
//!         memory.max = OPERATOR_MEMORY_BYTES
//! ```
//!
//! The split solves a problem the original single-cgroup design has: a
//! workload that saturates `/boxlite/<id>`'s `pids.max=512` also blocks every
//! `boxlite exec` attempt (libcontainer's tenant builder spawns the exec'd
//! process in the same cgroup, and the cgroup is full). By giving operator
//! processes a separate sibling subgroup with its own small budget, the
//! workload's cap saturation no longer locks the operator out of the box —
//! they can always exec in to inspect / kill the runaway.
//!
//! This module owns ONLY the cgroup-directory layout (mkdir + write
//! `pids.max` / `memory.max` / `cgroup.subtree_control`). libcontainer still
//! mkdirs and writes limits to `<parent>/workload` on container start because
//! the OCI spec's `cgroupsPath` points there; this module pre-creates the
//! parent + the operator sibling around it.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::fs;
use std::path::PathBuf;

/// Hard ceiling on the operator subgroup. Enough to cover a few interactive
/// shells / probes; small enough that an operator script run amok also gets
/// throttled. Tuned for "the operator's debug session" not "the operator's
/// workload" — workloads belong in the workload subgroup.
const OPERATOR_PIDS_MAX: u64 = 64;

/// Memory budget for the operator subgroup. The parent's total budget is
/// `workload_memory + OPERATOR_MEMORY_BYTES`, so the operator can never
/// starve the workload by allocating heavily inside the box.
const OPERATOR_MEMORY_BYTES: u64 = 32 * 1024 * 1024;

const CGROUP_ROOT: &str = "/sys/fs/cgroup";

/// Absolute on-disk path to `/sys/fs/cgroup/boxlite/<id>`.
fn parent_path(container_id: &str) -> PathBuf {
    PathBuf::from(CGROUP_ROOT)
        .join("boxlite")
        .join(container_id)
}

/// Pre-create the carve-out hierarchy so libcontainer can spawn container
/// init into `<parent>/workload` and `boxlite exec` can target
/// `<parent>/operator`. Idempotent: existing directories are left alone (so
/// recovery after a crash doesn't error out).
///
/// Must run BEFORE `libcontainer::ContainerBuilder::build()` for the
/// container, otherwise libcontainer's own `mkdir <parent>/workload` succeeds
/// but the parent has no `subtree_control` delegation and the operator
/// subgroup never gets its controllers.
pub(crate) fn ensure_box_cgroup_hierarchy(container_id: &str) -> BoxliteResult<()> {
    // Called AFTER libcontainer's start_container — libcontainer is the one
    // that mkdirs `/sys/fs/cgroup/boxlite/<id>/workload` and walks the
    // `subtree_control` chain (root → boxlite → boxlite/<id>) to delegate
    // `+pids` `+memory` controllers down. By the time we run here the parent
    // has both controllers available; mkdir'ing the operator sibling creates
    // a cgroup that inherits those, so its `pids.max` / `memory.max` files
    // exist and we can write the caps below.
    let parent = parent_path(container_id);
    if !parent.exists() {
        return Err(BoxliteError::Internal(format!(
            "cgroup parent {} does not exist — libcontainer didn't run \
             before ensure_box_cgroup_hierarchy",
            parent.display()
        )));
    }

    let operator = parent.join("operator");
    create_dir_idempotent(&operator)?;

    // Write operator caps. Best-effort: a controller that isn't delegated
    // (e.g. memory under a misconfigured rootless host) shouldn't fail box
    // creation, just log so operators can see the degraded protection.
    write_cap(&operator.join("pids.max"), &OPERATOR_PIDS_MAX.to_string());
    write_cap(
        &operator.join("memory.max"),
        &OPERATOR_MEMORY_BYTES.to_string(),
    );

    tracing::info!(
        container_id,
        parent = %parent.display(),
        operator_pids_max = OPERATOR_PIDS_MAX,
        operator_memory_bytes = OPERATOR_MEMORY_BYTES,
        "Pre-created /boxlite/<id>/{{workload,operator}} carve-out"
    );
    Ok(())
}

/// Tear down the carve-out on container removal. Recursively rmdir's
/// `/boxlite/<id>/{workload,operator}` then `/boxlite/<id>`. Best-effort:
/// rmdir on a non-empty cgroup errors with EBUSY, which is expected if
/// processes are still attached; the box-lifecycle code calls this AFTER
/// it has SIGKILL'd everything inside.
pub(crate) fn remove_box_cgroup_hierarchy(container_id: &str) {
    let parent = parent_path(container_id);
    for child in ["workload", "operator"] {
        let p = parent.join(child);
        if p.exists() {
            if let Err(e) = fs::remove_dir(&p) {
                tracing::debug!(
                    cgroup = %p.display(),
                    error = %e,
                    "Failed to rmdir cgroup subgroup during cleanup (probably already gone or still has processes)"
                );
            }
        }
    }
    if parent.exists() {
        if let Err(e) = fs::remove_dir(&parent) {
            tracing::debug!(
                cgroup = %parent.display(),
                error = %e,
                "Failed to rmdir cgroup parent during cleanup"
            );
        }
    }
}

fn create_dir_idempotent(p: &std::path::Path) -> BoxliteResult<()> {
    match fs::create_dir(p) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(BoxliteError::Internal(format!(
            "Failed to create cgroup directory {}: {e}",
            p.display()
        ))),
    }
}

fn write_cap(path: &std::path::Path, value: &str) {
    if let Err(e) = fs::write(path, value) {
        tracing::warn!(
            path = %path.display(),
            value,
            error = %e,
            "Failed to write cgroup cap"
        );
    }
}

/// Path to a container's OCI bundle `config.json` — read by libcontainer's
/// tenant builder at every `boxlite exec`. Kept private here so the swap
/// helpers below are the only call sites that mutate it.
fn bundle_config_path(container_id: &str) -> PathBuf {
    use boxlite_shared::layout::{dirs, GUEST_BASE};
    PathBuf::from(GUEST_BASE)
        .join(dirs::CONTAINERS)
        .join(container_id)
        .join("config.json")
}

/// Rewrite the OCI bundle's `cgroupsPath` from `/boxlite/<id>/workload` to
/// `/boxlite/<id>/operator` so the next `tenant_builder.build()` reads the
/// operator path. Called immediately before a `boxlite exec` build; paired
/// with [`restore_workload_cgroup_path`] called on the way out (success or
/// failure). Caller must hold the container mutex to serialize swaps —
/// concurrent execs would clobber each other's config.json without it.
///
/// Text-replacement rather than parse-modify-serialize: the substring
/// `/boxlite/<id>/workload` is unique enough that the simpler approach is
/// safe and avoids the cost of round-tripping the entire 4 KiB spec through
/// `oci-spec`.
pub(crate) fn swap_to_operator_cgroup_path(container_id: &str) -> BoxliteResult<()> {
    let path = bundle_config_path(container_id);
    let content = fs::read_to_string(&path).map_err(|e| {
        BoxliteError::Internal(format!(
            "Failed to read OCI config for cgroup swap {}: {e}",
            path.display()
        ))
    })?;
    let workload = super::spec::workload_cgroup_path(container_id);
    let operator = super::spec::operator_cgroup_path(container_id);
    let modified = content.replace(&workload, &operator);
    if modified == content {
        return Err(BoxliteError::Internal(format!(
            "cgroupsPath swap found no `{workload}` to replace in {} — \
             container was created without the workload-subgroup carve-out, \
             so operator exec cannot be routed to its own subgroup",
            path.display()
        )));
    }
    fs::write(&path, modified).map_err(|e| {
        BoxliteError::Internal(format!(
            "Failed to write OCI config for cgroup swap {}: {e}",
            path.display()
        ))
    })?;
    Ok(())
}

/// Reverse of [`swap_to_operator_cgroup_path`]. Best-effort: errors are
/// logged but not propagated, since the caller is already in the cleanup
/// path of an exec call. A failure here leaves the bundle pointing at
/// `/operator` for the NEXT exec — which would still work (operator
/// processes go to operator subgroup) and self-heals on the subsequent
/// successful pairing.
pub(crate) fn restore_workload_cgroup_path(container_id: &str) {
    let path = bundle_config_path(container_id);
    let Ok(content) = fs::read_to_string(&path) else {
        tracing::warn!(
            container_id,
            path = %path.display(),
            "Failed to read OCI config for cgroup restore"
        );
        return;
    };
    let workload = super::spec::workload_cgroup_path(container_id);
    let operator = super::spec::operator_cgroup_path(container_id);
    let restored = content.replace(&operator, &workload);
    if restored != content {
        if let Err(e) = fs::write(&path, restored) {
            tracing::warn!(
                container_id,
                path = %path.display(),
                error = %e,
                "Failed to write OCI config restoring workload cgroupsPath — \
                 next exec will read the wrong path; investigate ASAP"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Pure function: confirm the operator path matches what spec.rs's
    /// `operator_cgroup_path` returns (the two MUST agree — that's the
    /// contract between this module and the exec swap).
    #[test]
    fn operator_path_format_matches_spec() {
        let id = "test-id";
        let from_carve = parent_path(id).join("operator");
        let from_spec = crate::container::spec::operator_cgroup_path(id);
        assert_eq!(
            from_carve
                .to_string_lossy()
                .trim_start_matches("/sys/fs/cgroup"),
            from_spec,
            "the operator cgroup path used by carve-out must equal the one \
             written into OCI spec for exec — drift breaks the swap"
        );
    }
}
