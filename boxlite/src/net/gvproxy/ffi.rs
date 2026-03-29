//! Safe FFI wrappers for libgvproxy-sys
//!
//! This module provides safe, idiomatic Rust wrappers around the raw C FFI
//! functions from libgvproxy-sys. All unsafe operations are encapsulated here.

use std::ffi::{CStr, CString};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

use super::config::GvproxyConfig;
use libgvproxy_sys::{
    gvproxy_create, gvproxy_destroy, gvproxy_free_string, gvproxy_get_stats, gvproxy_get_version,
};

/// Create a new gvproxy instance with full configuration
///
/// # Arguments
/// * `config` - Complete gvproxy configuration
///
/// # Returns
/// Instance ID (handle) or error
pub fn create_instance(config: &GvproxyConfig) -> BoxliteResult<i64> {
    // Serialize full config to JSON
    let json = serde_json::to_string(config)
        .map_err(|e| BoxliteError::Network(format!("Failed to serialize config: {}", e)))?;

    let c_json = CString::new(json)
        .map_err(|e| BoxliteError::Network(format!("Invalid JSON string: {}", e)))?;

    // Call CGO function with full config
    let id = unsafe { gvproxy_create(c_json.as_ptr()) };

    if id < 0 {
        return Err(BoxliteError::Network("gvproxy_create failed".to_string()));
    }

    tracing::info!(id, "Created gvproxy instance via FFI");

    Ok(id)
}

/// Destroy a gvproxy instance and free resources
///
/// # Arguments
/// * `id` - Instance ID to destroy
///
/// # Returns
/// Ok(()) on success, error otherwise
pub fn destroy_instance(id: i64) -> BoxliteResult<()> {
    let result = unsafe { gvproxy_destroy(id) };

    if result != 0 {
        return Err(BoxliteError::Network(format!(
            "gvproxy_destroy failed for instance {}: code {}",
            id, result
        )));
    }

    tracing::info!(id, "Destroyed gvproxy instance via FFI");

    Ok(())
}

/// Get the gvproxy version string
///
/// # Returns
/// Version string or error
pub fn get_version() -> BoxliteResult<String> {
    let c_str = unsafe { gvproxy_get_version() };

    if c_str.is_null() {
        return Err(BoxliteError::Network(
            "gvproxy_get_version returned NULL".to_string(),
        ));
    }

    let version = unsafe { CStr::from_ptr(c_str) }
        .to_str()
        .map_err(|e| BoxliteError::Network(format!("Invalid UTF-8 in version string: {}", e)))?
        .to_string();

    Ok(version)
}

/// Get network statistics for a gvproxy instance
///
/// # Arguments
/// * `id` - Instance ID returned from `create_instance`
///
/// # Returns
/// JSON string containing stats, or error if:
/// - Instance doesn't exist
/// - VirtualNetwork not initialized yet
/// - Stats collection or serialization failed
pub fn get_stats_json(id: i64) -> BoxliteResult<String> {
    let c_str = unsafe { gvproxy_get_stats(id) };

    if c_str.is_null() {
        return Err(BoxliteError::Network(format!(
            "gvproxy_get_stats failed for instance {} (not found or not initialized)",
            id
        )));
    }

    let json_str = unsafe { CStr::from_ptr(c_str) }
        .to_str()
        .map_err(|e| BoxliteError::Network(format!("Invalid UTF-8 in stats JSON: {}", e)))?
        .to_string();

    // Free the string returned by CGO
    unsafe { gvproxy_free_string(c_str) };

    Ok(json_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore] // Requires libgvproxy.dylib to be available
    fn test_ffi_version() {
        let version = get_version().unwrap();
        assert!(!version.is_empty());
        assert!(version.contains("gvproxy-bridge"));
    }

    #[test]
    #[ignore] // Requires libgvproxy.dylib to be available
    fn test_ffi_create_destroy() {
        use std::path::PathBuf;
        let socket_path = PathBuf::from("/tmp/test-gvproxy-ffi.sock");
        let config = GvproxyConfig::new(socket_path, vec![(8080, 80), (8443, 443)]);
        let id = create_instance(&config).unwrap();

        // Destroy instance
        destroy_instance(id).unwrap();
    }
}
