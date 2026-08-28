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
pub(crate) mod safe_root;
mod time;
mod verifier;
pub(crate) mod whiteout;

pub use extractor::LayerExtractor;
pub use override_stat::{OverrideFileType, OverrideStat};
pub use safe_root::SafeRoot;
pub use verifier::LayerVerifier;
