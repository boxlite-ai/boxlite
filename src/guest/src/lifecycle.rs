//! PID 1 must reset the guest instead of returning through Rust or clap.

use nix::{libc, unistd::getpid};
use std::io::Write;

pub(crate) fn install_panic_hook() {
    let owns_init = getpid().as_raw() == 1;
    std::panic::set_hook(Box::new(move |panic_info| {
        // A failed console write must not panic recursively and abort init.
        let _ = writeln!(
            std::io::stderr(),
            "[PANIC] Guest agent panicked: {panic_info}"
        );
        if owns_init && getpid().as_raw() == 1 {
            restart(1);
        }
        std::process::exit(1);
    }));
}

pub(crate) fn exit(code: i32) -> ! {
    if getpid().as_raw() == 1 {
        restart(code);
    }
    std::process::exit(code);
}

fn restart(code: i32) -> ! {
    let _ = writeln!(
        std::io::stderr(),
        "[guest] PID 1 restarting (status {code})"
    );
    // SAFETY: these syscalls take no pointers. This path is only reachable by
    // the owning init process; sync flushes writes before the reset request.
    unsafe {
        libc::sync();
        libc::reboot(libc::LINUX_REBOOT_CMD_RESTART);
    }
    let error = std::io::Error::last_os_error();
    let _ = writeln!(
        std::io::stderr(),
        "[guest] reset failed: {error}; waiting for host cleanup"
    );
    loop {
        std::thread::park();
    }
}

#[cfg(test)]
#[path = "tests/lifecycle.rs"]
mod tests;
