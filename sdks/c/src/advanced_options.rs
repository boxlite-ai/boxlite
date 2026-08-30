//! C ABI for `boxlite::runtime::advanced_options::AdvancedBoxOptions`.
//!
//! Mirrors the core model: advanced knobs (capabilities, security, mount
//! isolation, health check) live under `BoxOptions.advanced`, never directly on the box. Build a
//! `CAdvancedBoxOptions` handle via `boxlite_advanced_options_new`, toggle the
//! sandbox with `boxlite_advanced_options_set_security_enabled`, then apply it
//! to a `CBoxliteOptions` via `boxlite_options_set_advanced`.

use std::os::raw::{c_char, c_int};

use boxlite::runtime::advanced_options::{
    AdvancedBoxOptions, ContainerCapabilities, SecurityOptions,
};

use crate::CAdvancedBoxOptions;
use crate::error::{BoxliteErrorCode, FFIError, null_pointer_error, write_error};
use crate::util::c_str_to_string;

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

/// Replace the capabilities added to BoxLite's Docker-compatible baseline.
///
/// A zero count clears the list. Negative counts, null handles, null arrays
/// with a positive count, null elements, and invalid UTF-8 fail closed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_advanced_options_set_capabilities_add(
    opts: *mut CAdvancedBoxOptions,
    capabilities: *const *const c_char,
    count: c_int,
) -> BoxliteErrorCode {
    set_capability_list(opts, capabilities, count, |caps, values| {
        caps.add = values;
    })
}

/// Replace the capabilities removed from the container capability set.
///
/// A zero count clears the list. Negative counts, null handles, null arrays
/// with a positive count, null elements, and invalid UTF-8 fail closed.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_advanced_options_set_capabilities_drop(
    opts: *mut CAdvancedBoxOptions,
    capabilities: *const *const c_char,
    count: c_int,
) -> BoxliteErrorCode {
    set_capability_list(opts, capabilities, count, |caps, values| {
        caps.drop = values;
    })
}

const INVALID_CAPABILITY_INPUT: &str = "<invalid C capability input>";

fn set_capability_list(
    handle: *mut CAdvancedBoxOptions,
    capabilities: *const *const c_char,
    count: c_int,
    assign: impl FnOnce(&mut ContainerCapabilities, Vec<String>),
) -> BoxliteErrorCode {
    let Some(handle) = (unsafe { handle.as_mut() }) else {
        return BoxliteErrorCode::InvalidArgument;
    };

    let mut current = handle.options.capabilities().cloned().unwrap_or_default();

    let parse_result = match parse_capability_array(capabilities, count) {
        Ok(values) => {
            assign(&mut current, values);
            BoxliteErrorCode::Ok
        }
        Err(()) => {
            // Keep the handle invalid if a caller ignores the return code. The
            // subsequent BoxOptions::sanitize call then rejects the policy
            // instead of silently falling back to the baseline.
            assign(&mut current, vec![INVALID_CAPABILITY_INPUT.to_string()]);
            BoxliteErrorCode::InvalidArgument
        }
    };

    // Only reachable if this handle's options were already resolved (used to
    // build a box request) — not possible through this C API today, since
    // `boxlite_options_set_advanced` clones the options rather than resolving
    // this handle directly, but fail closed rather than silently keep stale
    // capabilities if that ever changes.
    if handle.options.set_capabilities(Some(current)).is_err() {
        return BoxliteErrorCode::InvalidArgument;
    }

    parse_result
}

fn parse_capability_array(
    capabilities: *const *const c_char,
    count: c_int,
) -> Result<Vec<String>, ()> {
    if count < 0 {
        return Err(());
    }
    if count == 0 {
        return Ok(Vec::new());
    }
    if capabilities.is_null() {
        return Err(());
    }

    let mut values = Vec::with_capacity(count as usize);
    unsafe {
        for index in 0..count {
            let capability = *capabilities.add(index as usize);
            if capability.is_null() {
                return Err(());
            }
            values.push(c_str_to_string(capability).map_err(|_| ())?);
        }
    }
    Ok(values)
}
