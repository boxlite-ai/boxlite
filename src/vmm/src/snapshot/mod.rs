// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

pub(crate) mod export;
pub(crate) mod image;
pub(crate) mod state;

#[cfg(test)]
#[path = "../../tests/snapshot/execution.rs"]
mod execution_tests;
