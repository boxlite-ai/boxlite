// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Loads the pinned x86_64 ELF kernel through rust-vmm.

use std::io::{self, Cursor};

use linux_loader::loader::{Elf, KernelLoader};
use vm_memory::GuestMemoryBackend;

/// Loads into fresh zero-filled RAM and returns the ELF entry address.
///
/// BSS relies on the initial zeroes. A failed load may have written RAM;
/// discard that RAM before retrying.
pub(crate) fn load_elf<M: GuestMemoryBackend>(ram: &M, image: &[u8]) -> io::Result<u64> {
    Elf::load(ram, None, &mut Cursor::new(image), None)
        .map(|loaded| loaded.kernel_load.0)
        .map_err(io::Error::other)
}

#[cfg(test)]
#[path = "../../tests/boot/mod.rs"]
mod tests;
