//! bubblewrap-sys: Builds and bundles the bwrap binary from bubblewrap.
//!
//! Bubblewrap provides lightweight sandboxing via Linux namespaces.
//! This crate builds bwrap from source and exports the binary path
//! via `cargo:bwrap_BOXLITE_DEP` for bundling.
//!
//! ## Platform Support
//!
//! - **Linux**: Builds bwrap using Meson
//! - **macOS/Windows**: Skips build (bubblewrap is Linux-only)
//!
//! ## Build Dependencies
//!
//! On Linux, the following must be installed:
//! - `meson` (build system)
//! - `ninja-build` (build backend)
//! - `libcap-dev` (Linux capabilities library)
