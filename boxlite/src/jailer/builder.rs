//! Jailer struct and builder pattern.
//!
//! This module provides the main `Jailer` type for process isolation,
//! along with a fluent `JailerBuilder` for configuration.

use crate::jailer::config::{ResourceLimits, SecurityOptions};
use crate::runtime::options::VolumeSpec;
use std::path::{Path, PathBuf};

// ============================================================================
// Jailer Struct
// ============================================================================

/// Jailer provides process isolation for boxlite-shim.
///
/// Encapsulates security configuration and provides methods for spawn-time
/// isolation. All isolation (FD cleanup, rlimits, cgroups) is applied via
/// `pre_exec` hook before exec, eliminating the attack window.
///
/// # Example
///
/// ```ignore
/// use boxlite::jailer::{Jailer, JailerBuilder};
///
/// // Using constructor + builder pattern
/// let jailer = Jailer::new(&box_id, &box_dir)
///     .with_security(security);
///
/// // Or using JailerBuilder (non-consuming, C-BUILDER compliant)
/// let jailer = JailerBuilder::new()
///     .box_id(&box_id)
///     .box_dir(&box_dir)
///     .security(security)
///     .build()?;
///
/// jailer.setup_pre_spawn()?;
/// let cmd = jailer.build_command(&binary, &args);
/// cmd.spawn()?;
/// ```
#[derive(Debug, Clone)]
pub struct Jailer {
    /// Security configuration options
    pub(crate) security: SecurityOptions,
    /// Volume mounts (for sandbox path restrictions)
    pub(crate) volumes: Vec<VolumeSpec>,
    /// Unique box identifier
    pub(crate) box_id: String,
    /// Box directory path
    pub(crate) box_dir: PathBuf,
}

impl Jailer {
    // ─────────────────────────────────────────────────────────────────────
    // Constructors
    // ─────────────────────────────────────────────────────────────────────

    /// Create a new Jailer with default security options.
    pub fn new(box_id: impl Into<String>, box_dir: impl Into<PathBuf>) -> Self {
        Self {
            security: SecurityOptions::default(),
            volumes: Vec::new(),
            box_id: box_id.into(),
            box_dir: box_dir.into(),
        }
    }

    /// Create a builder for more flexible configuration.
    ///
    /// # Example
    ///
    /// ```ignore
    /// let jailer = Jailer::builder()
    ///     .box_id("my-box")
    ///     .box_dir("/path/to/box")
    ///     .security(SecurityOptions::standard())
    ///     .build()?;
    /// ```
    pub fn builder() -> JailerBuilder {
        JailerBuilder::new()
    }

    /// Set security options (consuming builder pattern - legacy API).
    ///
    /// Consider using `JailerBuilder` for more flexible configuration.
    pub fn with_security(mut self, security: SecurityOptions) -> Self {
        self.security = security;
        self
    }

    /// Set volume mounts (consuming builder pattern - legacy API).
    ///
    /// Volumes are used for sandbox path restrictions (macOS).
    /// All volumes are added to readable paths; writable volumes are also added to writable paths.
    pub fn with_volumes(mut self, volumes: Vec<VolumeSpec>) -> Self {
        self.volumes = volumes;
        self
    }

    // ─────────────────────────────────────────────────────────────────────
    // Getters
    // ─────────────────────────────────────────────────────────────────────

    /// Get the security options.
    pub fn security(&self) -> &SecurityOptions {
        &self.security
    }

    /// Get mutable reference to security options.
    pub fn security_mut(&mut self) -> &mut SecurityOptions {
        &mut self.security
    }

    /// Get the volumes.
    pub fn volumes(&self) -> &[VolumeSpec] {
        &self.volumes
    }

    /// Get the box ID.
    pub fn box_id(&self) -> &str {
        &self.box_id
    }

    /// Get the box directory.
    pub fn box_dir(&self) -> &Path {
        &self.box_dir
    }

    /// Get the resource limits.
    pub fn resource_limits(&self) -> &ResourceLimits {
        &self.security.resource_limits
    }

    // ─────────────────────────────────────────────────────────────────────
    // Associated functions (static)
    // ─────────────────────────────────────────────────────────────────────

    /// Check if jailer isolation is supported on this platform.
    pub fn is_supported() -> bool {
        crate::jailer::platform::current().is_available()
    }

    /// Get the current platform name.
    pub fn platform_name() -> &'static str {
        crate::jailer::platform::current().name()
    }
}

// ============================================================================
// JailerBuilder (C-BUILDER compliant - non-consuming)
// ============================================================================

/// Builder for constructing a Jailer with custom options.
///
/// This builder follows the Rust API Guidelines C-BUILDER pattern:
/// - Methods take `&mut self` and return `&mut Self` (non-consuming)
/// - Supports both one-liner construction and complex conditional configuration
///
/// # Example (One-liner)
///
/// ```ignore
/// let jailer = JailerBuilder::new()
///     .box_id("my-box")
///     .box_dir("/path/to/box")
///     .security(SecurityOptions::standard())
///     .build()?;
/// ```
///
/// # Example (Complex Configuration)
///
/// ```ignore
/// let mut builder = JailerBuilder::new();
/// builder.box_id("my-box").box_dir("/path/to/box");
///
/// if enable_seccomp {
///     let mut security = SecurityOptions::standard();
///     security.seccomp_enabled = true;
///     builder.security(security);
/// }
///
/// let jailer = builder.build()?;
/// ```
#[derive(Debug, Clone)]
pub struct JailerBuilder {
    security: SecurityOptions,
    volumes: Vec<VolumeSpec>,
    box_id: Option<String>,
    box_dir: Option<PathBuf>,
}

impl Default for JailerBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl JailerBuilder {
    /// Create a new JailerBuilder with default settings.
    pub fn new() -> Self {
        Self {
            security: SecurityOptions::default(),
            volumes: Vec::new(),
            box_id: None,
            box_dir: None,
        }
    }

    /// Set the box ID.
    ///
    /// # Arguments
    /// * `id` - Unique identifier for this box
    pub fn box_id(&mut self, id: impl Into<String>) -> &mut Self {
        self.box_id = Some(id.into());
        self
    }

    /// Set the box directory path.
    ///
    /// # Arguments
    /// * `dir` - Path to the box's directory (e.g., `~/.boxlite/boxes/{box_id}`)
    pub fn box_dir(&mut self, dir: impl Into<PathBuf>) -> &mut Self {
        self.box_dir = Some(dir.into());
        self
    }

    /// Set security options.
    ///
    /// # Arguments
    /// * `security` - Security configuration (use presets like `SecurityOptions::standard()`)
    pub fn security(&mut self, security: SecurityOptions) -> &mut Self {
        self.security = security;
        self
    }

    /// Set volume mounts.
    ///
    /// Volumes are used for sandbox path restrictions (macOS).
    /// All volumes are added to readable paths; writable volumes are also added to writable paths.
    ///
    /// # Arguments
    /// * `volumes` - List of volume specifications
    pub fn volumes(&mut self, volumes: Vec<VolumeSpec>) -> &mut Self {
        self.volumes = volumes;
        self
    }

    /// Add a single volume mount.
    ///
    /// # Arguments
    /// * `volume` - Volume specification to add
    pub fn add_volume(&mut self, volume: VolumeSpec) -> &mut Self {
        self.volumes.push(volume);
        self
    }

    /// Enable or disable jailer isolation.
    ///
    /// Shorthand for modifying `security.jailer_enabled`.
    pub fn jailer_enabled(&mut self, enabled: bool) -> &mut Self {
        self.security.jailer_enabled = enabled;
        self
    }

    /// Enable or disable seccomp filtering (Linux only).
    ///
    /// Shorthand for modifying `security.seccomp_enabled`.
    pub fn seccomp_enabled(&mut self, enabled: bool) -> &mut Self {
        self.security.seccomp_enabled = enabled;
        self
    }

    /// Build the Jailer.
    ///
    /// # Errors
    ///
    /// Returns [`JailerError::Config`] with [`ConfigError::InvalidConfig`] if:
    /// - `box_id` was not set
    /// - `box_dir` was not set
    ///
    /// # Example
    ///
    /// ```ignore
    /// let jailer = JailerBuilder::new()
    ///     .box_id("my-box")
    ///     .box_dir("/path/to/box")
    ///     .build()?;
    /// ```
    pub fn build(&self) -> Result<Jailer, crate::jailer::JailerError> {
        let box_id = self.box_id.clone().ok_or_else(|| {
            crate::jailer::ConfigError::InvalidConfig("box_id is required".to_string())
        })?;

        let box_dir = self.box_dir.clone().ok_or_else(|| {
            crate::jailer::ConfigError::InvalidConfig("box_dir is required".to_string())
        })?;

        Ok(Jailer {
            security: self.security.clone(),
            volumes: self.volumes.clone(),
            box_id,
            box_dir,
        })
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_jailer_new() {
        let jailer = Jailer::new("test-box", "/tmp/box");
        assert_eq!(jailer.box_id(), "test-box");
        assert_eq!(jailer.box_dir(), Path::new("/tmp/box"));
    }

    #[test]
    fn test_jailer_with_security() {
        let security = SecurityOptions::standard();
        let jailer = Jailer::new("test-box", "/tmp/box").with_security(security);
        assert!(jailer.security().jailer_enabled);
    }

    #[test]
    fn test_builder_basic() {
        let jailer = JailerBuilder::new()
            .box_id("test-box")
            .box_dir("/tmp/box")
            .build()
            .expect("Should build successfully");

        assert_eq!(jailer.box_id(), "test-box");
        assert_eq!(jailer.box_dir(), Path::new("/tmp/box"));
    }

    #[test]
    fn test_builder_missing_box_id() {
        let result = JailerBuilder::new().box_dir("/tmp/box").build();

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().contains("box_id"));
    }

    #[test]
    fn test_builder_missing_box_dir() {
        let result = JailerBuilder::new().box_id("test-box").build();

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().contains("box_dir"));
    }

    #[test]
    fn test_builder_with_security() {
        let jailer = JailerBuilder::new()
            .box_id("test-box")
            .box_dir("/tmp/box")
            .security(SecurityOptions::maximum())
            .build()
            .expect("Should build successfully");

        assert!(jailer.security().jailer_enabled);
    }

    #[test]
    fn test_builder_non_consuming() {
        // Verify that builder methods return &mut Self (non-consuming)
        let mut builder = JailerBuilder::new();

        // Should be able to call methods separately without move
        builder.box_id("test-box");
        builder.box_dir("/tmp/box");

        // And still access builder after calls
        builder.jailer_enabled(true);

        let jailer = builder.build().expect("Should build successfully");
        assert!(jailer.security().jailer_enabled);
    }

    #[test]
    fn test_builder_add_volume() {
        let jailer = JailerBuilder::new()
            .box_id("test-box")
            .box_dir("/tmp/box")
            .add_volume(VolumeSpec {
                host_path: "/data".to_string(),
                guest_path: "/mnt/data".to_string(),
                read_only: true,
            })
            .add_volume(VolumeSpec {
                host_path: "/output".to_string(),
                guest_path: "/mnt/output".to_string(),
                read_only: false,
            })
            .build()
            .expect("Should build successfully");

        assert_eq!(jailer.volumes().len(), 2);
    }
}
