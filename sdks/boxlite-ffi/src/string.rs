//! C string utilities for BoxLite FFI
//!
//! Provides functions for converting between Rust strings and C strings.

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::ptr;

use boxlite::BoxliteError;

/// Allocate a C string from a Rust string.
///
/// Caller must free with the corresponding free function.
/// Returns NULL if the string contains null bytes.
pub fn alloc_c_string(s: &str) -> *mut c_char {
    match CString::new(s) {
        Ok(cs) => cs.into_raw(),
        Err(_) => ptr::null_mut(),
    }
}

/// Parse a C string to Rust &str (borrowed).
///
/// Returns None if the pointer is null or contains invalid UTF-8.
///
/// # Safety
/// ptr must be null or a valid pointer to a null-terminated C string
pub unsafe fn parse_c_str<'a>(ptr: *const c_char) -> Option<&'a str> {
    unsafe {
        if ptr.is_null() {
            return None;
        }
        CStr::from_ptr(ptr).to_str().ok()
    }
}

/// Convert C string to Rust String (owned).
///
/// Returns an error if the pointer is null or contains invalid UTF-8.
///
/// # Safety
/// s must be null or a valid pointer to a null-terminated C string
pub unsafe fn c_str_to_string(s: *const c_char) -> Result<String, BoxliteError> {
    unsafe {
        if s.is_null() {
            return Err(BoxliteError::Internal("null pointer".to_string()));
        }
        CStr::from_ptr(s)
            .to_str()
            .map(|s| s.to_string())
            .map_err(|e| BoxliteError::Internal(format!("invalid UTF-8: {}", e)))
    }
}

/// Free a C string allocated by alloc_c_string.
///
/// # Safety
/// s must be null or a valid pointer to a C string allocated by alloc_c_string
pub unsafe fn free_c_string(s: *mut c_char) {
    unsafe {
        if !s.is_null() {
            drop(CString::from_raw(s));
        }
    }
}
