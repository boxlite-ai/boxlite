// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Guest boot loading. The VMM is the boot loader: it writes the boot data into
//! guest RAM itself and starts the boot vCPU at the kernel entry. This
//! increment sets up the x86_64 64-bit entry state; the kernel, `boot_params`,
//! the command line and the MP table follow in later M1 slices.

pub(crate) mod entry;
