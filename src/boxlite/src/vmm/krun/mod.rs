//! Libkrun-based engine implementation.

mod constants;
pub mod context;
pub mod engine;
pub mod factory;

use boxlite_shared::{BoxliteError, BoxliteResult};
pub use engine::Krun;
pub use factory::KrunFactory;

pub(crate) fn check_status(label: &str, status: i32) -> BoxliteResult<()> {
    if status < 0 {
        tracing::error!(function = label, status, "libkrun FFI call failed");
        if status == -22 {
            return Err(BoxliteError::Engine(format!(
                "libkrun function '{}' returned EINVAL (-22). Check that rootfs contains valid kernel and rootfs structure.",
                label
            )));
        }
        Err(BoxliteError::Engine(format!(
            "libkrun function '{}' failed with status {}",
            label, status
        )))
    } else {
        Ok(())
    }
}
