//! Unprivileged terminal initialization checks.

use crate::container::pty::initialize;
use crate::service::exec::exec_handle::{PtyConfig, PtyMode};
use nix::pty::{openpty, Winsize};
use nix::sys::termios::{tcgetattr, InputFlags, LocalFlags, SpecialCharacterIndices};
use std::os::fd::AsRawFd;

fn config() -> PtyConfig {
    PtyConfig {
        rows: 43,
        cols: 137,
        x_pixels: 640,
        y_pixels: 480,
        modes: vec![
            PtyMode {
                opcode: 51,
                value: 0,
            }, // ICANON
            PtyMode {
                opcode: 53,
                value: 0,
            }, // ECHO
            PtyMode {
                opcode: 36,
                value: 0,
            }, // ICRNL
            PtyMode {
                opcode: 1,
                value: 7,
            }, // VINTR
        ],
    }
}

#[test]
fn configured_terminal_exposes_modes_and_size_to_the_workload() {
    let pty = openpty(None, None).unwrap();
    initialize(&pty.slave, &config()).unwrap();
    let mut size = std::mem::MaybeUninit::<Winsize>::uninit();
    assert_eq!(
        unsafe {
            nix::libc::ioctl(
                pty.slave.as_raw_fd(),
                nix::libc::TIOCGWINSZ,
                size.as_mut_ptr(),
            )
        },
        0
    );
    assert_eq!(
        unsafe { size.assume_init() },
        Winsize {
            ws_row: 43,
            ws_col: 137,
            ws_xpixel: 640,
            ws_ypixel: 480
        }
    );
    let attrs = tcgetattr(&pty.slave).unwrap();
    assert!(!attrs
        .local_flags
        .intersects(LocalFlags::ICANON | LocalFlags::ECHO));
    assert!(!attrs.input_flags.contains(InputFlags::ICRNL));
    assert_eq!(
        attrs.control_chars[SpecialCharacterIndices::VINTR as usize],
        7
    );
}

#[test]
fn terminal_initialization_rejects_nonterminal_stdio() {
    let file = std::fs::File::open("/dev/null").unwrap();
    let error = initialize(&file, &config()).unwrap_err();
    assert!(error
        .to_string()
        .contains("Failed to set PTY window size (43x137)"));
}
