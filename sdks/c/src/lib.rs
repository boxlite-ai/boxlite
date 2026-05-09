//! C SDK for BoxLite
//!
//! This crate provides C FFI bindings for the BoxLite runtime,
//! building the C shared library and static library artifacts.

#![allow(unsafe_op_in_unsafe_fn)]
#![allow(clippy::missing_safety_doc)]
#![allow(clippy::too_many_arguments)]

mod box_handle;
mod copy;
mod error;
mod event_queue;
mod exec;
mod images;
mod info;
mod metrics;
mod options;
mod runtime;
#[cfg(test)]
mod tests;
mod util;

/// Test-only counter incremented every time `free_str` reclaims a
/// `CString::from_raw`'d inner pointer. Lets nested-leak reproducer
/// tests verify that `OwnedFfiPtr<T>::drop` for FFI payload types like
/// `CImagePullResult` actually traverses the struct's nested allocations
/// rather than only freeing the outer `Box`.
#[cfg(test)]
pub(crate) static FREE_STR_CALLS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

/// Serializes tests that observe `FREE_STR_CALLS` deltas. The counter is
/// process-global, so without this lock parallel cargo tests interleave
/// and produce false-positive failures (test A's `before` snapshot
/// includes test B's increments). Each leak-reproducer test must acquire
/// `FREE_STR_LOCK` before reading `FREE_STR_CALLS`.
#[cfg(test)]
pub(crate) static FREE_STR_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub type CBoxliteRuntime = runtime::RuntimeHandle;
pub type CBoxHandle = box_handle::BoxHandle;
pub type CBoxliteImageHandle = images::ImageHandle;
pub type CBoxliteOptions = options::OptionsHandle;
pub type CBoxliteSimple = exec::BoxRunner;
pub type CBoxliteError = error::FFIError;
pub type CBoxliteExecResult = exec::ExecResult;
pub type CBoxInfo = info::CBoxInfo;
pub type CBoxInfoList = info::CBoxInfoList;
pub type CBoxMetrics = metrics::CBoxMetrics;
pub type CExecutionHandle = exec::ExecutionHandle;
pub type CImageInfoList = images::CImageInfoList;
pub type CImagePullResult = images::CImagePullResult;
pub type CRuntimeMetrics = metrics::CRuntimeMetrics;
pub type BoxliteCommand = exec::BoxliteCommand;

pub use box_handle::*;
pub use copy::*;
pub use error::*;
pub use event_queue::*;
pub use exec::*;
pub use images::*;
pub use info::*;
pub use metrics::*;
pub use options::*;
pub use runtime::*;
pub use util::*;
