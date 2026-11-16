use super::*;
use std::os::unix::process::CommandExt;
use std::process::Command;

/// Read limits after production setup in a child, leaving the test runner intact.
fn child_file_size_limits(soft: Option<u64>, inherited: Option<u64>) -> (u64, u64) {
    let limits = ResourceLimits {
        max_file_size: soft,
        ..ResourceLimits::default()
    };
    let mut child = Command::new("/bin/cat");
    child.arg("/proc/self/limits");
    // SAFETY: the hook only sets resource limits through async-signal-safe calls.
    unsafe {
        child.pre_exec(move || {
            if let Some(hard) = inherited {
                let limit = libc::rlimit {
                    rlim_cur: hard as libc::rlim_t,
                    rlim_max: hard as libc::rlim_t,
                };
                if libc::setrlimit(libc::RLIMIT_FSIZE, &limit) != 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            apply_limits_raw(&limits).map_err(io::Error::from_raw_os_error)
        });
    }
    let output = child
        .output()
        .expect("file-size policy must allow child startup");
    assert!(output.status.success());
    let output = String::from_utf8(output.stdout).unwrap();
    let fields: Vec<_> = output
        .lines()
        .find(|line| line.starts_with("Max file size"))
        .unwrap()
        .split_whitespace()
        .collect();
    (fields[3].parse().unwrap(), fields[4].parse().unwrap())
}

#[test]
fn file_size_policy_preserves_soft_and_reserves_growth() {
    let (_, inherited) = get_rlimit(libc::RLIMIT_FSIZE).unwrap();
    for (soft, hard) in [
        (0, 2u64 << 40),
        (1 << 30, 2 << 40),
        (2 << 40, 2 << 40),
        (3 << 40, 3 << 40),
    ] {
        assert_eq!(
            child_file_size_limits(Some(soft), None),
            (soft.min(inherited), hard.min(inherited)),
            "configured soft limit: {soft}",
        );
    }
}

#[test]
fn file_size_policy_respects_the_inherited_hard_limit() {
    assert_eq!(child_file_size_limits(Some(1024), Some(4096)), (1024, 4096));
}

#[test]
fn file_size_policy_caps_soft_at_the_inherited_hard_limit() {
    assert_eq!(child_file_size_limits(Some(8192), Some(4096)), (4096, 4096));
}

#[test]
fn file_size_policy_leaves_unconfigured_limits_inherited() {
    assert_eq!(child_file_size_limits(None, Some(4096)), (4096, 4096));
}
