use super::*;
use std::os::unix::process::CommandExt;
use std::process::Command;

/// Read limits after production setup in a child, leaving the test runner intact.
fn child_file_size_limits(required: Option<u64>, inherited: Option<u64>) -> io::Result<(u64, u64)> {
    let limits = ResourceLimits {
        max_file_size: required,
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
    let output = child.output()?;
    assert!(output.status.success());
    let output = String::from_utf8(output.stdout).unwrap();
    let fields: Vec<_> = output
        .lines()
        .find(|line| line.starts_with("Max file size"))
        .unwrap()
        .split_whitespace()
        .collect();
    Ok((fields[3].parse().unwrap(), fields[4].parse().unwrap()))
}

#[test]
fn file_size_policy_sets_soft_and_hard_to_the_growth_budget() {
    let before = get_rlimit(libc::RLIMIT_FSIZE).unwrap();
    for (required, budget) in [
        (0, 2u64 << 40),
        (1 << 30, 2 << 40),
        (2 << 40, 2 << 40),
        (3 << 40, 3 << 40),
    ] {
        assert_eq!(
            child_file_size_limits(Some(required), None).unwrap(),
            (budget.min(before.1), budget.min(before.1)),
            "startup file-size requirement: {required}",
        );
    }
    assert_eq!(get_rlimit(libc::RLIMIT_FSIZE).unwrap(), before);
}

#[test]
fn file_size_policy_respects_the_inherited_hard_limit() {
    for required in [1024, 4096] {
        assert_eq!(
            child_file_size_limits(Some(required), Some(4096)).unwrap(),
            (4096, 4096)
        );
    }
}

#[test]
fn file_size_policy_rejects_an_insufficient_inherited_hard_limit() {
    assert_eq!(
        child_file_size_limits(Some(4097), Some(4096))
            .unwrap_err()
            .raw_os_error(),
        Some(libc::EPERM)
    );
}

#[test]
fn file_size_policy_leaves_unconfigured_limits_inherited() {
    assert_eq!(
        child_file_size_limits(None, Some(4096)).unwrap(),
        (4096, 4096)
    );
}
