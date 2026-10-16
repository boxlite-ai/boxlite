use crate::BoxliteError;

/// Options controlling copy behavior.
///
/// Whether a directory or its contents is copied is not an option: spell the
/// source `SRC/.` for the contents, as `docker cp` does.
#[derive(Debug, Clone)]
pub struct CopyOptions {
    /// Recursively copy directories.
    pub recursive: bool,
    /// Overwrite existing files/directories at destination.
    pub overwrite: bool,
    /// Follow symlinks when archiving (otherwise include symlinks as links).
    pub follow_symlinks: bool,
}

impl Default for CopyOptions {
    fn default() -> Self {
        Self {
            recursive: true,
            overwrite: true,
            follow_symlinks: false,
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

    pub fn validate_for_dir(&self) -> Result<(), BoxliteError> {
        if !self.recursive {
            return Err(BoxliteError::Config(
                "recursive=false not supported for directory copies".into(),
            ));
        }
        Ok(())
    }
}
