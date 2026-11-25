//! Host limits checked before an opted-in workload is created.

use std::fs;
use std::path::{Component, Path, PathBuf};

use boxlite_shared::{BoxliteError, BoxliteResult};

pub(super) async fn check(socket: &Path, window_bytes: u64) -> BoxliteResult<()> {
    // The saved shim identity can name the outer launcher. The server peer
    // owns the VMM mappings and inherits the actual address-space limit.
    let pid = tokio::net::UnixStream::connect(socket)
        .await?
        .peer_cred()?
        .pid()
        .filter(|pid| *pid > 0)
        .ok_or_else(|| BoxliteError::Engine("VMM socket did not report a process ID".into()))?;
    let proc = Path::new("/proc").join(pid.to_string());
    check_address_space(&proc, window_bytes)?;
    check_cgroups(
        &fs::read_to_string(proc.join("cgroup"))?,
        &fs::read_to_string("/proc/self/mountinfo")?,
        window_bytes,
    )
}

fn check_address_space(proc: &Path, window_bytes: u64) -> BoxliteResult<()> {
    let limits = fs::read_to_string(proc.join("limits"))?;
    let cap = limits
        .lines()
        .find_map(|line| line.strip_prefix("Max address space"))
        .and_then(|line| line.split_whitespace().next())
        .ok_or_else(|| observation_error("RLIMIT_AS"))?;
    if cap != "unlimited" {
        let status = fs::read_to_string(proc.join("status"))?;
        let used_kib = status
            .lines()
            .find_map(|line| line.strip_prefix("VmSize:"))
            .and_then(|line| line.split_whitespace().next())
            .ok_or_else(|| observation_error("VmSize"))?;
        let used = bytes(used_kib, "VmSize")?
            .checked_mul(1024)
            .ok_or_else(|| observation_error("VmSize"))?;
        require_headroom("RLIMIT_AS", bytes(cap, "RLIMIT_AS")?, used, window_bytes)?;
    }
    Ok(())
}

fn check_cgroups(cgroups: &str, mounts: &str, window_bytes: u64) -> BoxliteResult<()> {
    if cgroups.lines().any(|line| {
        line.split(':')
            .nth(1)
            .is_some_and(|controllers| controllers.split(',').any(|name| name == "memory"))
    }) {
        return Err(observation_error("cgroup v1 memory budget"));
    }
    let Some(group) = cgroups.lines().find_map(|line| line.strip_prefix("0::/")) else {
        return Ok(());
    };
    let relative = Path::new(group);
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(observation_error("cgroup path"));
    }
    // Both proc files describe paths relative to the observing process's cgroup namespace.
    // A subtree mount cannot establish that its hidden ancestors have enough headroom.
    let root = mounts
        .lines()
        .filter_map(cgroup_mount_root)
        .find(|path| {
            path.join("cgroup.controllers").is_file()
                && matches!(fs::symlink_metadata(path.join("cgroup.type")),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound)
        })
        .ok_or_else(|| observation_error("complete cgroup v2 hierarchy"))?;
    let directory = root.join(relative);
    for ancestor in directory
        .ancestors()
        .take_while(|path| path.starts_with(&root))
    {
        if ancestor == root {
            break;
        }
        // Confirm the cgroup exists even when its parent has disabled memory accounting.
        fs::metadata(ancestor.join("cgroup.controllers"))?;
        let cap = match fs::read_to_string(ancestor.join("memory.max")) {
            Ok(cap) if cap.trim() == "max" => continue,
            Ok(cap) => bytes(&cap, "memory.max")?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let parent = ancestor.parent().expect("non-root cgroup has a parent");
                let controllers = fs::read_to_string(parent.join("cgroup.subtree_control"))?;
                if controllers.split_whitespace().any(|name| name == "memory") {
                    return Err(observation_error("memory.max"));
                }
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        let used = bytes(
            &fs::read_to_string(ancestor.join("memory.current"))?,
            "memory.current",
        )?;
        require_headroom("cgroup memory.max", cap, used, window_bytes)?;
    }
    Ok(())
}

fn cgroup_mount_root(line: &str) -> Option<PathBuf> {
    let (mount, fs) = line.split_once(" - ")?;
    if !fs.starts_with("cgroup2 ") {
        return None;
    }
    let mut fields = mount.split_whitespace().skip(3);
    if fields.next()? != "/" {
        return None;
    }
    let path = fields
        .next()?
        .replace("\\040", " ")
        .replace("\\011", "\t")
        .replace("\\012", "\n")
        .replace("\\134", "\\");
    Some(PathBuf::from(path))
}

fn observation_error(field: &str) -> BoxliteError {
    BoxliteError::Engine(format!("cannot read {field} for the native memory budget"))
}

fn bytes(value: &str, field: &str) -> BoxliteResult<u64> {
    value.trim().parse().map_err(|_| observation_error(field))
}

fn require_headroom(name: &str, cap: u64, used: u64, window: u64) -> BoxliteResult<()> {
    if cap.saturating_sub(used) < window {
        return Err(BoxliteError::InvalidArgument(format!(
            "{name} is too low for the online memory window: {window} bytes needed, {} available",
            cap.saturating_sub(used)
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_cgroup_budget_checks_ancestors_at_the_observed_mount() {
        let temp = tempfile::tempdir().unwrap();
        let mount = temp.path().join("cgroup mount");
        let group = mount.join("limited");
        let leaf = group.join("shim");
        fs::create_dir_all(&leaf).unwrap();
        for directory in [&mount, &group, &leaf] {
            fs::write(directory.join("cgroup.controllers"), "memory\n").unwrap();
            fs::write(directory.join("cgroup.subtree_control"), "memory\n").unwrap();
        }
        fs::write(group.join("memory.max"), "2048\n").unwrap();
        fs::write(group.join("memory.current"), "1024\n").unwrap();
        fs::write(leaf.join("memory.max"), "max\n").unwrap();
        let mounts = format!(
            "23 20 0:22 / {} rw - cgroup2 none rw\n",
            mount.display().to_string().replace(' ', "\\040")
        );
        let membership = "0::/limited/shim\n";
        check_cgroups(membership, &mounts, 1024).unwrap();
        let error = check_cgroups(membership, &mounts, 1025).unwrap_err();
        assert!(
            matches!(error, BoxliteError::InvalidArgument(message) if message.contains("memory.max"))
        );
        fs::remove_file(leaf.join("memory.max")).unwrap();
        assert!(check_cgroups(membership, &mounts, 1024).is_err());
        assert!(check_cgroups(membership, &mounts.replace(" / ", " /limited "), 1024).is_err());
        fs::write(mount.join("cgroup.type"), "domain\n").unwrap();
        assert!(check_cgroups("0::/\n", &mounts, 1024).is_err());
    }

    #[test]
    fn host_address_space_budget_is_independent_of_cgroups() {
        let proc = tempfile::tempdir().unwrap();
        fs::write(
            proc.path().join("limits"),
            "Max address space 8192 8192 bytes\n",
        )
        .unwrap();
        fs::write(proc.path().join("status"), "VmSize: 4 kB\n").unwrap();
        check_address_space(proc.path(), 4096).unwrap();
        let error = check_address_space(proc.path(), 4097).unwrap_err();
        assert!(
            matches!(error, BoxliteError::InvalidArgument(message) if message.contains("RLIMIT_AS"))
        );
    }
}
