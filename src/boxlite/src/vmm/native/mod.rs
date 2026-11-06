//! The native engine: BoxLite's own VMM (`boxlite-vmm`) as a box engine.
//!
//! Linux x86_64 only, behind the `native` feature, and selected per box
//! through the `native-vmm` experimental opt-in. The VMM design
//! (`docs/contributing/architecture/vmm/README.md`, "Where the engine plugs
//! in") describes the adapter.

mod engine;

pub use engine::Native;

#[cfg(test)]
#[path = "tests/mod.rs"]
mod tests;
