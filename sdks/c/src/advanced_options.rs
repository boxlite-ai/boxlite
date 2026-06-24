//! C ABI for `boxlite::runtime::advanced_options::AdvancedBoxOptions`.
//!
//! Mirrors the core model: advanced knobs (security, mount isolation, health
//! check) live under `BoxOptions.advanced`, never directly on the box. Build a
//! `CAdvancedBoxOptions` handle via `boxlite_advanced_options_new`, toggle the
//! sandbox with `boxlite_advanced_options_set_security_enabled`, then apply it
//! to a `CBoxliteOptions` via `boxlite_options_set_advanced`.

use std::os::raw::c_int;

use boxlite::runtime::advanced_options::{AdvancedBoxOptions, SecurityOptions};

use crate::CAdvancedBoxOptions;
use crate::error::{BoxliteErrorCode, FFIError, null_pointer_error, write_error};

/// Opaque handle wrapping an `AdvancedBoxOptions`. Allocated via
/// `boxlite_advanced_options_new`, freed via `boxlite_advanced_options_free`.
pub struct AdvancedBoxOptionsHandle {
    pub options: AdvancedBoxOptions,
}

/// Allocate a `CAdvancedBoxOptions` initialized to `AdvancedBoxOptions::default()`
/// (secure-by-default security profile, mount isolation off, no health check).
///
/// Sets `*out_opts` to the new handle on `Ok`. The caller owns the handle and
/// must release it via `boxlite_advanced_options_free` once it has been applied
/// to a `CBoxliteOptions` via `boxlite_options_set_advanced` (or if no longer
/// needed).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_advanced_options_new(
    out_opts: *mut *mut CAdvancedBoxOptions,
    out_error: *mut FFIError,
) -> BoxliteErrorCode {
    unsafe {
        if out_opts.is_null() {
            write_error(out_error, null_pointer_error("out_opts"));
            return BoxliteErrorCode::InvalidArgument;
        }
        let handle = Box::new(AdvancedBoxOptionsHandle {
            options: AdvancedBoxOptions::default(),
        });
        *out_opts = Box::into_raw(handle);
        BoxliteErrorCode::Ok
    }
}

/// Release a `CAdvancedBoxOptions` previously returned by
/// `boxlite_advanced_options_new`. Null is a no-op.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_advanced_options_free(opts: *mut CAdvancedBoxOptions) {
    if opts.is_null() {
        return;
    }
    unsafe {
        drop(Box::from_raw(opts));
    }
}

/// Toggle the box's sandbox on the advanced options. `enabled` != 0 selects the
/// fully-isolated profile (`SecurityOptions::enabled()`, also the default when
/// this is never called); 0 selects `SecurityOptions::disabled()` (master
/// switch off, every sub-protection off — for debugging or environments that
/// genuinely can't sandbox). Null `opts` is a no-op.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_advanced_options_set_security_enabled(
    opts: *mut CAdvancedBoxOptions,
    enabled: c_int,
) {
    if opts.is_null() {
        return;
    }
    unsafe {
        (*opts).options.security = if enabled != 0 {
            SecurityOptions::enabled()
        } else {
            SecurityOptions::disabled()
        };
    }
}
