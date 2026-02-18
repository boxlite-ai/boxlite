//! Error handling utilities for BoxLite FFI
//!
//! Provides error codes and conversion functions for C API error handling.

use std::ffi::CString;
use std::os::raw::c_char;
use std::ptr;

use boxlite::BoxliteError;

// ============================================================================
// Error Code Enum - Maps to BoxliteError variants
// ============================================================================

/// Error codes returned by BoxLite C API functions.
///
/// These codes map directly to Rust's BoxliteError variants,
/// allowing programmatic error handling in C.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoxliteErrorCode {
    /// Operation succeeded
    Ok = 0,
    /// Internal error
    Internal = 1,
    /// Resource not found
    NotFound = 2,
    /// Resource already exists
    AlreadyExists = 3,
    /// Invalid state for operation
    InvalidState = 4,
    /// Invalid argument provided
    InvalidArgument = 5,
    /// Configuration error
    Config = 6,
    /// Storage error
    Storage = 7,
    /// Image error
    Image = 8,
    /// Network error
    Network = 9,
    /// Execution error
    Execution = 10,
    /// Resource stopped
    Stopped = 11,
    /// Engine error
    Engine = 12,
    /// Unsupported operation
    Unsupported = 13,
    /// Database error
    Database = 14,
    /// Portal/communication error
    Portal = 15,
    /// RPC error
    Rpc = 16,
    /// RPC transport error
    RpcTransport = 17,
    /// Metadata error
    Metadata = 18,
    /// Unsupported engine error
    UnsupportedEngine = 19,
}

/// Extended error information for C API.
///
/// Contains both an error code (for programmatic handling)
/// and an optional detailed message (for debugging).
#[repr(C)]
pub struct FFIError {
    /// Error code
    pub code: BoxliteErrorCode,
    /// Detailed error message (NULL if none, caller must free with boxlite_error_free)
    pub message: *mut c_char,
}

impl Default for FFIError {
    fn default() -> Self {
        FFIError {
            code: BoxliteErrorCode::Ok,
            message: ptr::null_mut(),
        }
    }
}

/// Map BoxliteError to BoxliteErrorCode
pub fn error_to_code(err: &BoxliteError) -> BoxliteErrorCode {
    match err {
        BoxliteError::Internal(_) => BoxliteErrorCode::Internal,
        BoxliteError::NotFound(_) => BoxliteErrorCode::NotFound,
        BoxliteError::AlreadyExists(_) => BoxliteErrorCode::AlreadyExists,
        BoxliteError::InvalidState(_) => BoxliteErrorCode::InvalidState,
        BoxliteError::InvalidArgument(_) => BoxliteErrorCode::InvalidArgument,
        BoxliteError::Config(_) => BoxliteErrorCode::Config,
        BoxliteError::Storage(_) => BoxliteErrorCode::Storage,
        BoxliteError::Image(_) => BoxliteErrorCode::Image,
        BoxliteError::Network(_) => BoxliteErrorCode::Network,
        BoxliteError::Execution(_) => BoxliteErrorCode::Execution,
        BoxliteError::Stopped(_) => BoxliteErrorCode::Stopped,
        BoxliteError::Engine(_) => BoxliteErrorCode::Engine,
        BoxliteError::Unsupported(_) => BoxliteErrorCode::Unsupported,
        BoxliteError::UnsupportedEngine => BoxliteErrorCode::UnsupportedEngine,
        BoxliteError::Database(_) => BoxliteErrorCode::Database,
        BoxliteError::Portal(_) => BoxliteErrorCode::Portal,
        BoxliteError::Rpc(_) => BoxliteErrorCode::Rpc,
        BoxliteError::RpcTransport(_) => BoxliteErrorCode::RpcTransport,
        BoxliteError::MetadataError(_) => BoxliteErrorCode::Metadata,
    }
}

/// Convert Rust error to C string (caller must free)
pub fn error_to_c_string(err: &BoxliteError) -> *mut c_char {
    let msg = format!("{}", err);
    match CString::new(msg) {
        Ok(s) => s.into_raw(),
        Err(_) => {
            let fallback = CString::new("Failed to format error message").unwrap();
            fallback.into_raw()
        }
    }
}

/// Convert Rust error to C error struct
pub fn error_to_c_error(err: BoxliteError) -> FFIError {
    let code = error_to_code(&err);
    let message = error_to_c_string(&err);
    FFIError { code, message }
}

/// Write error to output parameter (if not NULL)
///
/// # Safety
/// out_error must be null or a valid pointer to FFIError
pub unsafe fn write_error(out_error: *mut FFIError, err: BoxliteError) {
    unsafe {
        if !out_error.is_null() {
            *out_error = error_to_c_error(err);
        }
    }
}

/// Helper to create InvalidArgument error for NULL pointers
pub fn null_pointer_error(param_name: &str) -> BoxliteError {
    BoxliteError::InvalidArgument(format!("{} is null", param_name))
}
