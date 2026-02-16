//! JailerBuilder for constructing a [`Jailer`](super::Jailer).

use super::Jailer;
use super::sandbox::{PlatformSandbox, Sandbox};
use crate::runtime::advanced_options::SecurityOptions;
use crate::runtime::layout::BoxFilesystemLayout;
use crate::runtime::options::VolumeSpec;

/// Builder for constructing a [`Jailer`].
///
/// Uses a consuming builder pattern — each method takes ownership and returns
/// the modified builder, enabling fluent chains.
///
/// # Example
///
/// ```ignore
/// let jail = JailerBuilder::new()
///     .with_box_id("my-box")
///     .with_layout(layout)
///     .with_security(SecurityOptions::standard())
///     .build()?;
/// ```
#[derive(Debug, Clone)]
pub struct JailerBuilder {
    security: SecurityOptions,
    volumes: Vec<VolumeSpec>,
    box_id: Option<String>,
    layout: Option<BoxFilesystemLayout>,
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
            layout: None,
        }
    }

    /// Set the box ID (required).
    pub fn with_box_id(mut self, id: impl Into<String>) -> Self {
        self.box_id = Some(id.into());
        self
    }

    /// Set the box filesystem layout (required).
    pub fn with_layout(mut self, layout: BoxFilesystemLayout) -> Self {
        self.layout = Some(layout);
        self
    }

    /// Set security options.
    pub fn with_security(mut self, security: SecurityOptions) -> Self {
        self.security = security;
        self
    }

    /// Set volume mounts.
    ///
    /// Volumes are used for sandbox path restrictions.
    /// All volumes are added to readable paths; writable volumes also get write access.
    pub fn with_volumes(mut self, volumes: Vec<VolumeSpec>) -> Self {
        self.volumes = volumes;
        self
    }

    /// Add a single volume mount.
    pub fn with_volume(mut self, volume: VolumeSpec) -> Self {
        self.volumes.push(volume);
        self
    }

    /// Enable or disable jailer isolation.
    pub fn with_jailer_enabled(mut self, enabled: bool) -> Self {
        self.security.jailer_enabled = enabled;
        self
    }

    /// Enable or disable seccomp filtering (Linux only).
    pub fn with_seccomp_enabled(mut self, enabled: bool) -> Self {
        self.security.seccomp_enabled = enabled;
        self
    }

    /// Build with the platform-default sandbox.
    ///
    /// On Linux: [`BwrapSandbox`](super::sandbox::BwrapSandbox)
    /// On macOS: [`SeatbeltSandbox`](super::sandbox::SeatbeltSandbox)
    /// On other: [`NoopSandbox`](super::sandbox::NoopSandbox)
    ///
    /// # Errors
    ///
    /// Returns [`JailerError::Config`](super::JailerError) with
    /// [`ConfigError::InvalidConfig`](super::ConfigError) if `box_id` or `box_dir` was not set.
    pub fn build(self) -> Result<Jailer<PlatformSandbox>, crate::jailer::JailerError> {
        self.build_with(PlatformSandbox::new())
    }

    /// Build with a custom sandbox implementation.
    ///
    /// Useful for testing or injecting alternative sandbox behavior.
    ///
    /// # Errors
    ///
    /// Returns [`JailerError::Config`](super::JailerError) with
    /// [`ConfigError::InvalidConfig`](super::ConfigError) if `box_id` or `layout` was not set.
    pub fn build_with<S: Sandbox>(
        self,
        sandbox: S,
    ) -> Result<Jailer<S>, crate::jailer::JailerError> {
        let box_id = self.box_id.ok_or_else(|| {
            crate::jailer::ConfigError::InvalidConfig("box_id is required".to_string())
        })?;

        let layout = self.layout.ok_or_else(|| {
            crate::jailer::ConfigError::InvalidConfig("layout is required".to_string())
        })?;

        Ok(Jailer {
            sandbox,
            security: self.security,
            volumes: self.volumes,
            box_id,
            layout,
        })
    }
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::layout::FsLayoutConfig;
    use std::path::{Path, PathBuf};

    /// Create a test layout from a box directory path.
    fn test_layout(box_dir: impl Into<PathBuf>) -> BoxFilesystemLayout {
        BoxFilesystemLayout::new(box_dir.into(), FsLayoutConfig::without_bind_mount(), false)
    }

    #[test]
    fn test_builder_basic() {
        let jailer = JailerBuilder::new()
            .with_box_id("test-box")
            .with_layout(test_layout("/tmp/box"))
            .build()
            .expect("Should build successfully");

        assert_eq!(jailer.box_id(), "test-box");
        assert_eq!(jailer.box_dir(), Path::new("/tmp/box"));
    }

    #[test]
    fn test_builder_missing_box_id() {
        let result = JailerBuilder::new()
            .with_layout(test_layout("/tmp/box"))
            .build();

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().contains("box_id"));
    }

    #[test]
    fn test_builder_missing_layout() {
        let result = JailerBuilder::new().with_box_id("test-box").build();

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(err.to_string().contains("layout"));
    }

    #[test]
    fn test_builder_with_security() {
        let jailer = JailerBuilder::new()
            .with_box_id("test-box")
            .with_layout(test_layout("/tmp/box"))
            .with_security(SecurityOptions::maximum())
            .build()
            .expect("Should build successfully");

        assert!(jailer.security().jailer_enabled);
    }

    #[test]
    fn test_builder_consuming_chain() {
        let jailer = JailerBuilder::new()
            .with_box_id("test-box")
            .with_layout(test_layout("/tmp/box"))
            .with_jailer_enabled(true)
            .build()
            .expect("Should build successfully");

        assert!(jailer.security().jailer_enabled);
    }

    #[test]
    fn test_builder_with_volume() {
        let jailer = JailerBuilder::new()
            .with_box_id("test-box")
            .with_layout(test_layout("/tmp/box"))
            .with_volume(VolumeSpec {
                host_path: "/data".to_string(),
                guest_path: "/mnt/data".to_string(),
                read_only: true,
            })
            .with_volume(VolumeSpec {
                host_path: "/output".to_string(),
                guest_path: "/mnt/output".to_string(),
                read_only: false,
            })
            .build()
            .expect("Should build successfully");

        assert_eq!(jailer.volumes().len(), 2);
    }

    #[test]
    fn test_builder_with_custom_sandbox() {
        use crate::jailer::NoopSandbox;

        let jailer = JailerBuilder::new()
            .with_box_id("test-box")
            .with_layout(test_layout("/tmp/box"))
            .build_with(NoopSandbox::new())
            .expect("Should build with custom sandbox");

        assert_eq!(jailer.box_id(), "test-box");
    }
}
