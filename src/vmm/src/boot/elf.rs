// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Loads the pinned x86_64 ELF kernel through rust-vmm.

use std::io::{self, Read, Seek};

use linux_loader::loader::{Elf, KernelLoader};
use vm_memory::{GuestMemoryBackend, ReadVolatile};

/// Copies the loadable segments of `kernel`, usually the kernel file, into
/// fresh zero-filled RAM and returns the ELF entry address.
///
/// BSS relies on the initial zeroes. A failed load may have written RAM;
/// discard that RAM before retrying.
pub(crate) fn load_elf<M, K>(ram: &M, kernel: &mut K) -> io::Result<u64>
where
    M: GuestMemoryBackend,
    K: Read + ReadVolatile + Seek,
{
    Elf::load(ram, None, kernel, None)
        .map(|loaded| loaded.kernel_load.0)
        .map_err(io::Error::other)
}

#[cfg(test)]
#[path = "../../tests/elf/mod.rs"]
pub(crate) mod tests;
