use super::*;
use std::os::unix::process::CommandExt;
use std::process::Command;

#[test]
fn file_size_limits_are_inherited_with_a_legacy_setting() {
    let before = get_rlimit(libc::RLIMIT_FSIZE).unwrap();
    let soft = 4096;
    let hard = 8192;
    let mut child = Command::new("/bin/cat");
    child.arg("/proc/self/limits");

    // SAFETY: the test installs finite process limits in the child only.
    unsafe {
        child.pre_exec(move || {
            let inherited = libc::rlimit {
                rlim_cur: soft,
                rlim_max: hard,
            };
            if libc::setrlimit(libc::RLIMIT_FSIZE, &inherited) != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    crate::jailer::pre_exec::add_pre_exec_hook(
        &mut child,
        ResourceLimits {
            max_file_size: Some(1024),
            ..ResourceLimits::default()
        },
        None,
        vec![],
        false,
    );

    let output = child.output().expect("run the launch child");
    assert!(output.status.success());
    let output = String::from_utf8(output.stdout).unwrap();
    let values = output
        .lines()
        .find_map(|line| line.strip_prefix("Max file size"))
        .expect("file-size limit row");
    let mut values = values.split_whitespace().map(str::parse::<libc::rlim_t>);
    assert_eq!(
        (
            values.next().unwrap().unwrap(),
            values.next().unwrap().unwrap()
        ),
        (soft, hard),
        "launch must preserve both inherited limits"
    );
    assert_eq!(get_rlimit(libc::RLIMIT_FSIZE).unwrap(), before);
}
