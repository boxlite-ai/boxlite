// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The devices behind the buses, and the platform code that adds them.

pub(crate) mod balloon;
pub(crate) mod console;
#[cfg(target_arch = "x86_64")]
pub(crate) mod i8042;
#[cfg(target_arch = "x86_64")]
pub(crate) mod serial;
#[cfg_attr(not(test), expect(dead_code, reason = "VM wiring follows separately."))]
pub(crate) mod virtio_console;
#[cfg(target_arch = "x86_64")]
pub(crate) mod x86_64;
