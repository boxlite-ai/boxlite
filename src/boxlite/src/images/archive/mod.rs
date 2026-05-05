//! Archive helpers (containerd-style apply).
//!
//! Mirrors containerd's layout: `extractor` performs the streaming layer
//! apply, `verifier` checks DiffIDs, `compression` opens tarballs with
//! transparent gzip detection, `metadata` groups per-entry header data,
//! `time` provides time helpers, `override_stat` provides rootless container
//! support, `safe_root` enforces containment.

#[cfg(unix)]
mod compression;
#[cfg(unix)]
mod extractor;
#[cfg(unix)]
mod metadata;
#[cfg(unix)]
mod override_stat;
#[cfg(unix)]
mod safe_root;
#[cfg(unix)]
mod time;
#[cfg(unix)]
mod verifier;

#[cfg(unix)]
pub use extractor::LayerExtractor;
#[cfg(unix)]
pub use verifier::LayerVerifier;
