// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Loads the pinned x86_64 ELF kernel through rust-vmm.

use std::io::{self, Read, Seek};

use linux_loader::loader::{Elf, KernelLoader};
use vm_memory::{GuestMemoryBackend, ReadVolatile};

/// What `load_elf` loaded into guest RAM.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct LoadedKernel {
    /// The ELF entry address.
    pub(crate) entry: u64,
    /// The highest physical address written by the ELF segments.
    pub(crate) end: u64,
}

/// Copies the loadable segments of `kernel`, usually the kernel file, into
/// fresh zero-filled RAM and returns the ELF entry address and the highest
/// physical address written.
///
/// BSS relies on the initial zeroes. A failed load may have written RAM;
/// discard that RAM before retrying.
pub(crate) fn load_elf<M, K>(ram: &M, kernel: &mut K) -> io::Result<LoadedKernel>
where
    M: GuestMemoryBackend,
    K: Read + ReadVolatile + Seek,
{
    Elf::load(ram, None, kernel, None)
        .map(|loaded| LoadedKernel {
            entry: loaded.kernel_load.0,
            end: loaded.kernel_end,
        })
        .map_err(io::Error::other)
}

#[cfg(test)]
#[path = "../../tests/elf/mod.rs"]
pub(crate) mod tests;
