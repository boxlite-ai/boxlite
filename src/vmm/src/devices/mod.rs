// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The devices behind the buses, and the platform code that adds them.

#[cfg(target_arch = "aarch64")]
pub(crate) mod arm64;
pub(crate) mod console;
#[cfg(target_arch = "x86_64")]
pub(crate) mod i8042;
#[cfg(target_arch = "aarch64")]
pub(crate) mod pl011;
#[cfg(target_arch = "x86_64")]
pub(crate) mod serial;
#[cfg(target_arch = "x86_64")]
pub(crate) mod x86_64;
