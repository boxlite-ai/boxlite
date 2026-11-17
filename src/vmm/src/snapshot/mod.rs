// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Device-less, stopped-machine memory images.

pub(crate) mod image;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub(crate) mod restore;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub(crate) mod state;

#[cfg(test)]
#[path = "../../tests/snapshot/image.rs"]
mod tests;

#[cfg(test)]
#[path = "../../tests/snapshot/import.rs"]
mod import_tests;
