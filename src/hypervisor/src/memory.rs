// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Guest memory regions backed by host memory.

use std::ptr::NonNull;

/// Host memory mapped into the guest physical address space.
///
/// Both addresses and the size are multiples of the host page size, which is
/// 16 KiB on Apple silicon. [`Vm::map_memory`](crate::Vm::map_memory) states
/// how long the host memory must stay valid.
#[derive(Debug, Clone, Copy)]
pub struct MemoryRegion {
    /// Guest physical address of the first byte.
    pub guest_addr: u64,
    /// Host virtual address of the first byte.
    pub host_addr: NonNull<u8>,
    /// Length in bytes.
    pub size: usize,
}
