// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Hypervisor.framework operations on macOS arm64, with the in-kernel GICv3
//! of macOS 15. The backend decodes exits itself and answers what Linux asks
//! the firmware at boot (PSCI queries, the OS lock); `CPU_ON` and device
//! accesses go to the VMM.

use std::io;

mod ffi;
mod psci;
mod syndrome;
mod vcpu;
mod vm;

pub use vcpu::{HvfVcpu, HvfVcpuHandle};
pub use vm::HvfVm;

/// Converts an `hv_return_t` to an `io::Error` that keeps the code, with a
/// kind a caller can act on: `PermissionDenied` without the hypervisor
/// entitlement, `Unsupported` without hypervisor support, `ResourceBusy` for
/// a second VM in one process.
pub(super) fn check(code: ffi::hv_return_t) -> io::Result<()> {
    use io::ErrorKind::{
        InvalidInput, Other, OutOfMemory, PermissionDenied, ResourceBusy, Unsupported,
    };
    let (kind, name) = match code {
        ffi::HV_SUCCESS => return Ok(()),
        ffi::HV_DENIED => (PermissionDenied, "HV_DENIED"),
        ffi::HV_UNSUPPORTED => (Unsupported, "HV_UNSUPPORTED"),
        ffi::HV_NO_DEVICE => (Unsupported, "HV_NO_DEVICE"),
        ffi::HV_BUSY => (ResourceBusy, "HV_BUSY"),
        ffi::HV_NO_RESOURCES => (OutOfMemory, "HV_NO_RESOURCES"),
        ffi::HV_BAD_ARGUMENT => (InvalidInput, "HV_BAD_ARGUMENT"),
        ffi::HV_ERROR => (Other, "HV_ERROR"),
        ffi::HV_FAULT => (Other, "HV_FAULT"),
        _ => (Other, "unknown hv_return_t"),
    };
    Err(io::Error::new(kind, format!("{name} ({:#x})", code as u32)))
}

#[cfg(test)]
#[path = "../../tests/hvf/mod.rs"]
mod tests;
