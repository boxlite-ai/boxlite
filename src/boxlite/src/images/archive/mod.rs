//! Archive helpers (containerd-style apply).
//!
//! Mirrors containerd's layout: `tar` module contains the streaming layer apply,
//! `time` provides time helpers, `override_stat` provides rootless container support.

mod override_stat;
mod tar;
mod time;

#[allow(unused_imports)]
pub use tar::extract_layer_tarball_streaming;
