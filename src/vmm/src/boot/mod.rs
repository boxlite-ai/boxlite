// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Kernel loading and x86_64 64-bit entry setup. Boot data and lifecycle
//! wiring follow in later M1 slices.

pub(crate) mod elf;
pub(crate) mod entry;
