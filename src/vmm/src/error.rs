// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Provisional error result until backend errors are defined.

pub(crate) type VmResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;
