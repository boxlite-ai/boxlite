//! Runtime binary discovery for boxlite-shim, boxlite-guest, mke2fs, debugfs.
//!
//! This module provides a flexible way to locate runtime binaries that are
//! bundled with BoxLite. The search follows a priority order:
//!
//! 1. `BOXLITE_RUNTIME_DIR` - Explicit override (highest priority)
//! 2. `DYLD_LIBRARY_PATH` (macOS) / `LD_LIBRARY_PATH` (Linux) - User-specified runtime location
//! 3. dladdr-based detection - For packaged/installed scenarios

use std::path::PathBuf;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};

/// Builder for configuring [`RuntimeBinaryFinder`] with custom search paths.
///
/// # Example
///
/// ```ignore
/// let finder = RuntimeBinaryFinder::builder()
///     .with_path("/custom/path")
///     .with_path("/another/path")
///     .build();
/// ```
#[derive(Default)]
pub struct BinaryFinderBuilder {
    search_paths: Vec<PathBuf>,
}

impl BinaryFinderBuilder {
    /// Add a search path.
    pub fn with_path(mut self, path: impl Into<PathBuf>) -> Self {
        self.search_paths.push(path.into());
        self
    }

    /// Build the finder.
    pub fn build(self) -> RuntimeBinaryFinder {
        RuntimeBinaryFinder {
            search_paths: self.search_paths,
        }
    }
}

/// Finds runtime binaries (boxlite-shim, boxlite-guest, mke2fs, debugfs)
/// by searching configured paths in priority order.
///
/// # Example
///
/// ```ignore
/// // Using the default configuration
/// let finder = RuntimeBinaryFinder::from_env();
/// let shim_path = finder.find("boxlite-shim")?;
/// let guest_path = finder.find("boxlite-guest")?;
///
/// // Or use the convenience function
/// let path = find_binary("boxlite-shim")?;
/// ```
pub struct RuntimeBinaryFinder {
    search_paths: Vec<PathBuf>,
}

impl RuntimeBinaryFinder {
    /// Create a builder for custom configuration.
    pub fn builder() -> BinaryFinderBuilder {
        BinaryFinderBuilder::default()
    }

    /// Create a finder with standard paths from environment variables.
    ///
    /// Search priority:
    /// 1. `BOXLITE_RUNTIME_DIR` (explicit override)
    /// 2. `DYLD_LIBRARY_PATH` / `LD_LIBRARY_PATH` (user-specified runtime location)
    /// 3. dladdr-based detection (for packaged scenarios)
    pub fn from_env() -> Self {
        let mut builder = Self::builder();

        // 1. Explicit override (highest priority)
        if let Ok(runtime_dir) = std::env::var("BOXLITE_RUNTIME_DIR") {
            for path in runtime_dir.split(':').filter(|s| !s.is_empty()) {
                builder = builder.with_path(path);
            }
        }

        // 2. Library path environment variables
        #[cfg(target_os = "macos")]
        {
            if let Ok(dyld_path) = std::env::var("DYLD_LIBRARY_PATH") {
                for path in dyld_path.split(':').filter(|s| !s.is_empty()) {
                    builder = builder.with_path(path);
                }
            }
            if let Ok(dyld_fallback) = std::env::var("DYLD_FALLBACK_LIBRARY_PATH") {
                for path in dyld_fallback.split(':').filter(|s| !s.is_empty()) {
                    builder = builder.with_path(path);
                }
            }
        }

        #[cfg(target_os = "linux")]
        {
            if let Ok(ld_path) = std::env::var("LD_LIBRARY_PATH") {
                for path in ld_path.split(':').filter(|s| !s.is_empty()) {
                    builder = builder.with_path(path);
                }
            }
        }

        // 3. dladdr-based detection (for packaged scenarios)
        if let Some(lib_dir) =
            super::LibraryLoadPath::get(None).and_then(|p| p.parent().map(|d| d.to_path_buf()))
        {
            // Direct sibling (e.g., binaries next to .so/.dylib)
            builder = builder.with_path(&lib_dir);
            // Runtime subdirectory (e.g., packaged installations)
            builder = builder.with_path(lib_dir.join("runtime"));
        }

        // 4. Compile-time fallback: embedded by build.rs via cargo:rustc-env.
        // Same name as the runtime env var — runtime check (above) takes priority.
        // Only used if the directory still exists (won't survive cargo clean).
        if let Some(dir) = option_env!("BOXLITE_RUNTIME_DIR") {
            let path = std::path::Path::new(dir);
            if path.exists() {
                builder = builder.with_path(path);
            }
        }

        builder.build()
    }

    /// Find a binary by name, searching all configured paths.
    pub fn find(&self, binary_name: &str) -> BoxliteResult<PathBuf> {
        for search_path in &self.search_paths {
            let candidate = search_path.join(binary_name);
            tracing::debug!("Finding binary {:?} in path: {:?}", binary_name, candidate);
            if candidate.exists() {
                tracing::debug!(binary = %candidate.display(), "Found binary");
                return Ok(candidate);
            }
        }

        let locations = self
            .search_paths
            .iter()
            .map(|p| format!("  - {}", p.join(binary_name).display()))
            .collect::<Vec<_>>()
            .join("\n");

        Err(BoxliteError::Storage(format!(
            "Binary '{}' not found.\nSearched locations:\n{}",
            binary_name, locations
        )))
    }
}

/// Find a runtime binary by name using the default search configuration.
///
/// This is a convenience wrapper around [`RuntimeBinaryFinder::from_env`].
///
/// # Example
///
/// ```ignore
/// let shim_path = find_binary("boxlite-shim")?;
/// ```
pub fn find_binary(binary_name: &str) -> BoxliteResult<PathBuf> {
    RuntimeBinaryFinder::from_env().find(binary_name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn test_builder_with_path() {
        let finder = RuntimeBinaryFinder::builder()
            .with_path("/path/one")
            .with_path("/path/two")
            .build();

        assert_eq!(finder.search_paths.len(), 2);
        assert_eq!(finder.search_paths[0], PathBuf::from("/path/one"));
        assert_eq!(finder.search_paths[1], PathBuf::from("/path/two"));
    }

    #[test]
    fn test_find_binary_success() {
        let temp_dir = TempDir::new().unwrap();
        let binary_path = temp_dir.path().join("test-binary");
        fs::write(&binary_path, "fake binary").unwrap();

        let finder = RuntimeBinaryFinder::builder()
            .with_path(temp_dir.path())
            .build();

        let result = finder.find("test-binary");
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), binary_path);
    }

    #[test]
    fn test_find_binary_not_found() {
        let finder = RuntimeBinaryFinder::builder()
            .with_path("/nonexistent/path")
            .build();

        let result = finder.find("nonexistent-binary");
        assert!(result.is_err());
        assert!(
            result
                .unwrap_err()
                .to_string()
                .contains("Binary 'nonexistent-binary' not found")
        );
    }

    #[test]
    fn test_find_binary_priority_order() {
        let temp_dir1 = TempDir::new().unwrap();
        let temp_dir2 = TempDir::new().unwrap();

        // Create binary in both directories
        fs::write(temp_dir1.path().join("test-binary"), "binary1").unwrap();
        fs::write(temp_dir2.path().join("test-binary"), "binary2").unwrap();

        // First path should win
        let finder = RuntimeBinaryFinder::builder()
            .with_path(temp_dir1.path())
            .with_path(temp_dir2.path())
            .build();

        let result = finder.find("test-binary").unwrap();
        assert_eq!(result, temp_dir1.path().join("test-binary"));
    }
}
