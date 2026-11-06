//! The native engine: BoxLite's own VMM (`boxlite-vmm`) as a box engine.
//!
//! Linux x86_64 only, behind the `native` feature, and selected per box
//! through the `native-vmm` experimental opt-in. See the engine-adapter design
//! (<https://github.com/boxlite-ai/boxlite/issues/2369>).

mod engine;

pub use engine::Native;

#[cfg(test)]
#[path = "tests/mod.rs"]
mod tests;
