//! C ABI for `boxlite::runtime::advanced_options::AdvancedBoxOptions`.
//!
//! Mirrors the core model: advanced knobs (capabilities, security, mount
//! privileged mode, capabilities, security, mount isolation, health check) live under
//! `BoxOptions.advanced`, never directly on the box. Build a
//! `CAdvancedBoxOptions` handle via `boxlite_advanced_options_new`, toggle the
//! sandbox with `boxlite_advanced_options_set_security_enabled`, then apply it
//! to a `CBoxliteOptions` via `boxlite_options_set_advanced`.

use std::os::raw::{c_char, c_int};

use boxlite::runtime::advanced_options::{AdvancedBoxOptions, SecurityOptions};

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

/// Toggle Docker-style privileged mode. Enabling it also normalizes the
/// capability policy to `ALL` with no drops; the guest still receives the
/// privileged shape and capabilities as separate fields.
///
/// Enabling over an explicit, non-canonical capability override already set
/// via `boxlite_advanced_options_set_capabilities_add`/`_drop` fails closed
/// with `InvalidArgument` instead of silently keeping the override — the same
/// conflict those two functions themselves reject when called in the other
/// order (privileged first, then a conflicting override).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_advanced_options_set_privileged(
    opts: *mut CAdvancedBoxOptions,
    enabled: c_int,
) -> BoxliteErrorCode {
    let Some(handle) = (unsafe { opts.as_mut() }) else {
        return BoxliteErrorCode::InvalidArgument;
    };
    let enabled = enabled != 0;
    if enabled {
        // Probe on a clone rather than flipping the real flag first: cheap
        // (a couple of string vecs), and the handle never passes through a
        // transiently-inconsistent state a concurrent reader could observe.
        let mut probe = handle.options.clone();
        probe.privileged = true;
        if probe.validate_privileged_capability_conflict().is_err() {
            return BoxliteErrorCode::InvalidArgument;
        }
    }
    handle.options.set_privileged(enabled);
    BoxliteErrorCode::Ok
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
    set_capability_list(opts, capabilities, count, |options, values| {
        options.capabilities.add = values;
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
    set_capability_list(opts, capabilities, count, |options, values| {
        options.capabilities.drop = values;
    })
}

const INVALID_CAPABILITY_INPUT: &str = "<invalid C capability input>";

fn set_capability_list(
    handle: *mut CAdvancedBoxOptions,
    capabilities: *const *const c_char,
    count: c_int,
    assign: impl Fn(&mut AdvancedBoxOptions, Vec<String>),
) -> BoxliteErrorCode {
    let Some(handle) = (unsafe { handle.as_mut() }) else {
        return BoxliteErrorCode::InvalidArgument;
    };

    match parse_capability_array(capabilities, count) {
        Ok(values) => {
            if handle.options.privileged {
                // Probe on a clone: whether this conflicts with privileged
                // mode depends on the *resulting* shape (add=["ALL"], empty
                // drop is not a conflict — it is what privileged mode itself
                // installs), not on whether this one field is merely
                // non-empty, so it can't be decided without applying it
                // first. `validate_privileged_capability_conflict` is the
                // core's own rule for that shape; reuse it instead of a
                // second copy of the condition.
                let mut probe = handle.options.clone();
                assign(&mut probe, values.clone());
                if probe.validate_privileged_capability_conflict().is_err() {
                    // Preserve a fail-closed marker if the caller ignores the
                    // return code.
                    assign(
                        &mut handle.options,
                        vec![INVALID_CAPABILITY_INPUT.to_string()],
                    );
                    return BoxliteErrorCode::InvalidArgument;
                }
            }
            assign(&mut handle.options, values);
            BoxliteErrorCode::Ok
        }
        Err(()) => {
            // Keep the handle invalid if a caller ignores the return code. The
            // subsequent BoxOptions::sanitize call then rejects the policy
            // instead of silently falling back to the baseline.
            assign(
                &mut handle.options,
                vec![INVALID_CAPABILITY_INPUT.to_string()],
            );
            BoxliteErrorCode::InvalidArgument
        }
    }
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
