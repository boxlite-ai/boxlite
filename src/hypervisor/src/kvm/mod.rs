// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! KVM operations. The initial implementation targets Linux x86_64.

#[cfg(target_arch = "x86_64")]
mod memory;

#[cfg(target_arch = "x86_64")]
mod vm;

#[cfg(target_arch = "x86_64")]
pub use vm::KvmVm;
