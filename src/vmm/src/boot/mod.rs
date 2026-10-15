// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Guest boot loading. The VMM is the boot loader: it writes the kernel into
//! guest RAM itself. This increment decodes an x86_64 ELF `vmlinux`; placing
//! it in guest RAM, `boot_params`, the command line, the MP table and the
//! entry registers follow in later M1 slices.

pub(crate) mod elf;

/// Where a loaded kernel sits in guest physical memory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct KernelLayout {
    /// Physical address of the first instruction (`e_entry`).
    pub(crate) entry: u64,
    /// Lowest physical address any `PT_LOAD` segment occupies.
    pub(crate) start: u64,
    /// One past the highest byte any `PT_LOAD` segment occupies, BSS included.
    pub(crate) end: u64,
}
