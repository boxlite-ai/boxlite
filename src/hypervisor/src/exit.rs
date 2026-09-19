// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Decoded vCPU exits shared by host backends and the VMM.

/// A guest exit requiring VMM handling, without backend-specific state.
///
/// Future backend entry points must tie `'a` to their mutable vCPU borrow:
/// MMIO buffers borrow backend storage and must be handled before re-entry.
/// Buffer length is the access width in bytes; bytes follow guest address order.
///
/// Handling MMIO supplies the device response but does not complete the guest
/// instruction. The backend must finish pending I/O on re-entry. Before stopping
/// the vCPU or saving its state, it must finish pending I/O without executing
/// further instructions.
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
    /// Host interruption; recheck control requests before re-entry.
    Interrupted,
    /// This vCPU is idle until woken; the VM has not requested shutdown.
    Halted,
    /// Guest request to shut down the VM.
    Shutdown,
    /// Guest request to reset the VM.
    Reset,
}
