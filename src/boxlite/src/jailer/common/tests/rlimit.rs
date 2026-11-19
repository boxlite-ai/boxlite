use super::*;
use std::os::unix::process::CommandExt;
use std::process::Command;

#[test]
fn file_size_limit_follows_launch_configuration() {
    let before = get_rlimit(libc::RLIMIT_FSIZE).unwrap();
    assert_eq!(launch_file_size_limits(None), (4096, 8192));
    assert_eq!(launch_file_size_limits(Some(1024)), (1024, 1024));
    assert_eq!(get_rlimit(libc::RLIMIT_FSIZE).unwrap(), before);
}

fn launch_file_size_limits(max_file_size: Option<u64>) -> (libc::rlim_t, libc::rlim_t) {
    let mut child = Command::new("/bin/cat");
    child.arg("/proc/self/limits");

    // SAFETY: the test installs finite process limits in the child only.
    unsafe {
        child.pre_exec(|| {
            let inherited = libc::rlimit {
                rlim_cur: 4096,
                rlim_max: 8192,
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
            max_file_size,
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
    (
        values.next().unwrap().unwrap(),
        values.next().unwrap().unwrap(),
    )
}
