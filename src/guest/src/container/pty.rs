//! Set terminal attributes before handing a PTY to its workload.

use crate::service::exec::exec_handle::PtyConfig;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::os::fd::AsRawFd;

pub(super) fn initialize(fd: &impl AsRawFd, config: &PtyConfig) -> BoxliteResult<()> {
    let winsize = nix::pty::Winsize {
        ws_row: config.rows,
        ws_col: config.cols,
        ws_xpixel: config.x_pixels,
        ws_ypixel: config.y_pixels,
    };
    // SAFETY: winsize is live for the ioctl; fd remains borrowed throughout.
    if unsafe { nix::libc::ioctl(fd.as_raw_fd(), nix::libc::TIOCSWINSZ, &winsize) } == -1 {
        return Err(BoxliteError::Internal(format!(
            "Failed to set PTY window size ({}x{}): {}",
            config.rows,
            config.cols,
            std::io::Error::last_os_error()
        )));
    }
    crate::service::exec::tty::apply_modes(fd, &config.modes)
}
