//! Shared test infrastructure for boxlite integration tests.
//!
//! # Modules
//!
//! - [`assertions`] — Assertion macros (`assert_ok!`, `assert_err!`, etc.)
//! - [`config_matrix`] — Multi-configuration test runner
//! - [`cache`] — Shared image/rootfs cache (`SharedResources`)
//! - [`home`] — Per-test isolated home directory (`PerTestBoxHome`)
//! - [`box_test`] — Per-test fixture with helpers (`BoxTestBase`)
//! - [`registry`] — Local registry that answers image pulls from disk (`LocalRegistry`)
//! - [`sync_point`] — Async sync points for concurrency testing
//! - [`fault_injection`] — Fault injection framework
//!
//! # Quick Start
//!
//! - [`home::PerTestBoxHome::new()`]: Per-test home with shared image cache (for VM tests).
//! - [`home::PerTestBoxHome::isolated()`]: Per-test home without cache (for non-VM tests).
//! - [`test_registries()`]: The local registry, so box starts never reach the internet.

pub mod assertions;
pub mod box_test;
pub mod cache;
pub mod config_matrix;
pub mod fault_injection;
pub mod home;
pub mod registry;
pub mod sync_point;

/// Shutdown timeout for test runtimes (seconds).
pub const TEST_SHUTDOWN_TIMEOUT: i32 = 10;

/// Images to pre-pull during cache warm-up.
pub const TEST_IMAGES: &[&str] = &["alpine:latest", "python:alpine"];

/// Docker Hub mirrors and `docker.io` itself: on a miss, the local registry
/// records whichever answers first.
pub const UPSTREAM_REGISTRIES: &[&str] = &[
    "docker.m.daocloud.io",
    "docker.xuanyuan.me",
    "docker.1ms.run",
    "docker.io",
];

/// `local` (the default) or `upstream`, which pulls straight from
/// [`UPSTREAM_REGISTRIES`] as the suites did before the local registry.
const REGISTRIES_MODE: &str = "BOXLITE_TEST_REGISTRIES";

/// The registries every harness runtime lists: only this process's
/// [`registry::local_registry`], which answers from its recordings, unless
/// `BOXLITE_TEST_REGISTRIES=upstream` asks for the public mirrors.
pub fn test_registries() -> Vec<boxlite::ImageRegistry> {
    match std::env::var(REGISTRIES_MODE).as_deref() {
        Ok("upstream") => UPSTREAM_REGISTRIES
            .iter()
            .map(|host| boxlite::ImageRegistry::https(*host).with_search(true))
            .collect(),
        Ok("local") | Err(_) => vec![registry::local_registry().search_registry()],
        Ok(other) => panic!("{REGISTRIES_MODE}={other}: expected local or upstream"),
    }
}
