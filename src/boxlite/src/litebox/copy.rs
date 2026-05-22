use std::path::PathBuf;

use crate::BoxliteError;

/// Options controlling copy behavior.
#[derive(Debug, Clone)]
pub struct CopyOptions {
    /// Recursively copy directories.
    pub recursive: bool,
    /// Overwrite existing files/directories at destination.
    pub overwrite: bool,
    /// Follow symlinks when archiving (otherwise include symlinks as links).
    pub follow_symlinks: bool,
    /// When copying out, include the parent directory in the archive (docker cp semantics).
    pub include_parent: bool,
}

impl Default for CopyOptions {
    fn default() -> Self {
        Self {
            recursive: true,
            overwrite: true,
            follow_symlinks: false,
            include_parent: true,
        }
    }
}

impl CopyOptions {
    pub fn no_overwrite(mut self) -> Self {
        self.overwrite = false;
        self
    }

    pub fn non_recursive(mut self) -> Self {
        self.recursive = false;
        self
    }

    pub fn follow_symlinks(mut self, follow: bool) -> Self {
        self.follow_symlinks = follow;
        self
    }

    pub fn include_parent(mut self, include: bool) -> Self {
        self.include_parent = include;
        self
    }

    pub fn validate_for_dir(&self) -> Result<(), BoxliteError> {
        if !self.recursive {
            return Err(BoxliteError::Config(
                "recursive=false not supported for directory copies".into(),
            ));
        }
        Ok(())
    }
}

/// One source/destination pair for [`LiteBox::copy_out_many`]. The bulk
/// endpoint emits one part per input; pairing src→dst at the call site
/// gives the caller per-file destination control and avoids basename
/// collisions when two srcs share a leaf name.
#[derive(Debug, Clone)]
pub struct CopyOutPair {
    pub container_src: String,
    pub host_dst: PathBuf,
}

/// Per-pair outcome from [`LiteBox::copy_out_many`]. `error == None` means
/// the file was written to `host_dst`. `error == Some(text)` means the
/// server reported a per-file failure OR the SDK failed to write to disk;
/// the batch continues either way. The wire returns plain text in
/// `name="error"` parts, so the SDK preserves the same shape — callers
/// cannot pattern-match `BoxliteError` variants per pair.
#[derive(Debug, Clone)]
pub struct CopyOutOutcome {
    pub container_src: String,
    pub host_dst: PathBuf,
    pub error: Option<String>,
}
