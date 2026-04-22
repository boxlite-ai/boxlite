//! Archive helpers (containerd-style apply).
//!
//! Mirrors containerd's layout: `extractor` performs the streaming layer
//! apply, `verifier` checks DiffIDs, `compression` opens tarballs with
//! transparent gzip detection, `metadata` groups per-entry header data,
//! `time` provides time helpers, `override_stat` provides rootless container
//! support, `safe_root` enforces containment.

mod compression;
mod extractor;
mod metadata;
mod override_stat;
mod safe_root;
mod time;
mod verifier;

pub use extractor::LayerExtractor;
pub use verifier::LayerVerifier;
