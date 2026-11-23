//! Initialize the terminal in the tenant child, before its workload can use it.

use crate::service::exec::exec_handle::PtyConfig;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use libcontainer::oci_spec::runtime::Spec;
use libcontainer::workload::{
    Executor, ExecutorError, ExecutorSetEnvsError, ExecutorValidationError,
};
use std::collections::HashMap;
use std::os::fd::AsRawFd;

#[derive(Clone)]
pub(super) struct PtyExecutor {
    pub inner: Box<dyn Executor>,
    pub config: Option<PtyConfig>,
}

impl Executor for PtyExecutor {
    fn exec(&self, spec: &Spec) -> Result<(), ExecutorError> {
        if let Some(config) = &self.config {
            // Youki has already wired the slave to stdin. Its tenant build
            // waits for exec-notify EOF, so waiting for parent-side attachment
            // here would deadlock. Configure locally before delegating instead.
            initialize(&std::io::stdin(), config)
                .map_err(|error| ExecutorError::Execution(Box::new(error)))?;
        }
        self.inner.exec(spec)
    }

    fn validate(&self, spec: &Spec) -> Result<(), ExecutorValidationError> {
        self.inner.validate(spec)
    }

    fn setup_envs(&self, envs: HashMap<String, String>) -> Result<(), ExecutorSetEnvsError> {
        self.inner.setup_envs(envs)
    }
}

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
