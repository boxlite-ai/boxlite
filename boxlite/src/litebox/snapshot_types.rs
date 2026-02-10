//! Options types for snapshot, export, and clone operations.

/// Options for creating a snapshot.
#[derive(Debug, Clone, Default)]
pub struct SnapshotOptions {
    // Quiesce fields present for future guest-side FIFREEZE support.
    // Currently no-op.
}

/// Options for exporting a box archive.
#[derive(Debug, Clone)]
pub struct ExportOptions {
    /// Whether to compress the archive with zstd (default: true).
    pub compress: bool,
    /// Zstd compression level (default: 3, range: 1-22).
    pub compression_level: i32,
    /// Whether to include metadata in the archive (default: true).
    pub include_metadata: bool,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            compress: true,
            compression_level: 3,
            include_metadata: true,
        }
    }
}

impl ExportOptions {
    /// Set whether to compress the archive.
    pub fn compress(&mut self, compress: bool) -> &mut Self {
        self.compress = compress;
        self
    }

    /// Set the zstd compression level (1-22).
    pub fn compression_level(&mut self, level: i32) -> &mut Self {
        self.compression_level = level;
        self
    }

    /// Set whether to include metadata.
    pub fn include_metadata(&mut self, include: bool) -> &mut Self {
        self.include_metadata = include;
        self
    }
}

/// Options for cloning a box.
#[derive(Debug, Clone)]
pub struct CloneOptions {
    /// Use COW (copy-on-write) for disk images (default: true).
    /// When false, performs a full copy (flattens COW chains).
    pub cow: bool,
    /// Start the cloned box after creation (default: false).
    pub start_after_clone: bool,
    /// Create clone from a named snapshot instead of current state.
    pub from_snapshot: Option<String>,
}

impl Default for CloneOptions {
    fn default() -> Self {
        Self {
            cow: true,
            start_after_clone: false,
            from_snapshot: None,
        }
    }
}

impl CloneOptions {
    /// Set whether to use COW for disk images.
    pub fn cow(&mut self, cow: bool) -> &mut Self {
        self.cow = cow;
        self
    }

    /// Set whether to start the clone after creation.
    pub fn start_after_clone(&mut self, start: bool) -> &mut Self {
        self.start_after_clone = start;
        self
    }

    /// Create clone from a named snapshot.
    pub fn from_snapshot(&mut self, name: impl Into<String>) -> &mut Self {
        self.from_snapshot = Some(name.into());
        self
    }
}
