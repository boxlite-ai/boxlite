// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Decoded vCPU exits shared by host backends and the VMM.

/// A guest exit requiring VMM handling, without backend-specific state.
///
/// [`Vcpu::run`](crate::Vcpu::run) ties `'a` to its mutable vCPU borrow: MMIO
/// and port buffers borrow backend storage and must be handled before re-entry.
/// Buffer length is the access width in bytes; bytes follow guest address order.
/// Each exit carries one access: backends report string port I/O (`rep ins`,
/// `rep outs`) as [`Error::UnhandledExit`](crate::Error::UnhandledExit), since
/// Linux drives the 8250, CMOS RTC and i8042 with single accesses.
///
/// Handling an access supplies the device response but does not complete the
/// guest instruction. The backend must finish pending I/O on re-entry. Before
/// stopping the vCPU or saving its state, the caller releases the exit borrow
/// and calls [`Vcpu::complete_pending_io`](crate::Vcpu::complete_pending_io)
/// to finish the access without executing further instructions.
#[derive(Debug)]
pub enum VcpuExit<'a> {
    /// Read from an emulated device; fill the entire buffer before re-entry.
    MmioRead {
        /// Guest physical byte address.
        guest_addr: u64,
        /// Borrowed storage for the device response.
        bytes: &'a mut [u8],
    },
    /// Write guest-supplied bytes to an emulated device.
    MmioWrite {
        /// Guest physical byte address.
        guest_addr: u64,
        /// Borrowed guest data, unchanged by device handling.
        bytes: &'a [u8],
    },
    /// Read from an emulated I/O port; fill the entire buffer before re-entry.
    #[cfg(target_arch = "x86_64")]
    IoIn {
        /// Port number.
        port: u16,
        /// Borrowed storage for the device response.
        bytes: &'a mut [u8],
    },
    /// Write guest-supplied bytes to an emulated I/O port.
    #[cfg(target_arch = "x86_64")]
    IoOut {
        /// Port number.
        port: u16,
        /// Borrowed guest data, unchanged by device handling.
        bytes: &'a [u8],
    },
    /// Host interruption; recheck control requests before re-entry.
    Interrupted,
    /// This vCPU is idle until woken; the VM has not requested shutdown.
    Halted,
    /// Guest request to shut down the VM.
    Shutdown,
    /// Guest request to reset the VM.
    Reset,
}
