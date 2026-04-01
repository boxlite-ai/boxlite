//! Shared FFI layer for BoxLite SDKs
//!
//! This crate provides common utilities for C FFI bindings across all BoxLite SDKs:
//! - Error handling and error codes
//! - C string allocation and parsing
//! - JSON serialization helpers
//! - Runtime management (Tokio + BoxliteRuntime)
//! - Core FFI operations implementation

pub mod error;
pub mod json;
pub mod ops;
pub mod runner;
pub mod runtime;
pub mod string;

pub use error::*;
pub use json::*;
pub use runtime::*;
pub use string::*;
