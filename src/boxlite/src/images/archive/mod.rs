//! Archive helpers (containerd-style apply).
//!
//! Mirrors containerd's layout: `tar` module contains the streaming layer apply,
//! `time` provides time helpers, `override_stat` provides rootless container support.

#[cfg(unix)]
mod override_stat;
#[cfg(unix)]
mod tar;
#[cfg(unix)]
mod time;

#[cfg(unix)]
#[allow(unused_imports)]
pub use tar::extract_layer_tarball_streaming;
