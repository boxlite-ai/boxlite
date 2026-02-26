//! Shared test infrastructure for boxlite integration tests.
//!
//! # Modules
//!
//! - [`assertions`] — Assertion macros (`assert_ok!`, `assert_err!`, etc.)
//! - [`config_matrix`] — Multi-configuration test runner
//! - [`cache`] — Shared image/rootfs cache (`SharedResources`)
//! - [`home`] — Per-test isolated home directory (`PerTestBoxHome`)
//! - [`box_test`] — Per-test fixture with helpers (`BoxTestBase`)
//! - [`sync_point`] — Async sync points for concurrency testing
//! - [`fault_injection`] — Fault injection framework
//!
//! # Quick Start
//!
//! - [`home::PerTestBoxHome::new()`]: Per-test home with shared image cache (for VM tests).
//! - [`home::PerTestBoxHome::isolated()`]: Per-test home without cache (for non-VM tests).
//! - [`test_registries()`]: Docker Hub mirror registries for reliable pulls.

pub mod assertions;
pub mod box_test;
pub mod cache;
pub mod config_matrix;
pub mod fault_injection;
pub mod home;
pub mod sync_point;

/// Shutdown timeout for test runtimes (seconds).
pub const TEST_SHUTDOWN_TIMEOUT: i32 = 10;

/// Images to pre-pull during cache warm-up.
pub const TEST_IMAGES: &[&str] = &["alpine:latest", "debian:bookworm-slim"];

/// Docker Hub mirror registries for reliable image pulls.
/// Mirrors are tried first; `docker.io` is the final fallback.
pub const TEST_REGISTRIES: &[&str] = &[
    "docker.m.daocloud.io",
    "docker.xuanyuan.me",
    "docker.1ms.run",
    "docker.io",
];

/// Convert `TEST_REGISTRIES` to `Vec<String>` for `BoxliteOptions::image_registries`.
pub fn test_registries() -> Vec<String> {
    TEST_REGISTRIES.iter().map(|s| s.to_string()).collect()
}
