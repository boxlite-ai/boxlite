use crate::BoxliteError;

/// Shape of a streaming copy's source: a directory tree, a single file, or
/// unknown.
///
/// `Unknown` is the honest answer when the producer cannot tell (a peer that
/// predates the hint, or a caller streaming bytes it did not pack). The
/// receiver then peeks the archive to decide the extraction shape, which costs
/// a staged copy — so pass `File`/`Dir` whenever the shape is known.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CopySourceKind {
    Unknown,
    File,
    Dir,
}

impl CopySourceKind {
    /// The wire encoding: proto's `optional bool source_is_dir`.
    pub fn to_wire(self) -> Option<bool> {
        match self {
            Self::Unknown => None,
            Self::File => Some(false),
            Self::Dir => Some(true),
        }
    }

    /// Decode the wire hint; a peer that omits it reports `Unknown`.
    pub fn from_wire(source_is_dir: Option<bool>) -> Self {
        match source_is_dir {
            None => Self::Unknown,
            Some(false) => Self::File,
            Some(true) => Self::Dir,
        }
    }

    pub fn is_dir(self) -> bool {
        matches!(self, Self::Dir)
    }
}

/// Resolve trusted host ancestors, leaving the destination leaf for extraction's
/// no-overwrite check. Guest archive components never use this host policy.
pub(super) fn host_copy_destination(path: &std::path::Path) -> std::io::Result<std::path::PathBuf> {
    let absolute = std::path::absolute(path)?;
    let Some(leaf) = absolute.file_name() else {
        return absolute.canonicalize();
    };
    let parent = absolute.parent().unwrap();
    // Copy-out already creates host parents. Let the filesystem interpret `..`
    // and symlinks before canonicalizing, rather than normalizing them lexically.
    let mut resolved = match parent.canonicalize() {
        Ok(resolved) => resolved,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir_all(parent)?;
            parent.canonicalize()?
        }
        Err(error) => return Err(error),
    };
    resolved.push(leaf);
    Ok(resolved)
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_destination_preserves_directory_intent() {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("missing/output/");
        let resolved = host_copy_destination(&output).unwrap();
        assert_eq!(
            resolved,
            root.path().canonicalize().unwrap().join("missing/output")
        );
    }

    #[test]
    fn host_destination_resolves_missing_parent_components() {
        let root = tempfile::tempdir().unwrap();
        let output = root.path().join("missing/../output");
        let resolved = host_copy_destination(&output)
            .expect("missing parents containing .. must remain valid");
        assert_eq!(resolved, root.path().canonicalize().unwrap().join("output"));
    }

    #[test]
    fn host_destination_resolves_filesystem_paths() {
        let root = tempfile::tempdir_in(".").unwrap();
        let canonical = root.path().canonicalize().unwrap();
        assert_eq!(
            host_copy_destination(&root.path().join("file")).unwrap(),
            canonical.join("file")
        );
        assert_eq!(
            host_copy_destination(std::path::Path::new("/")).unwrap(),
            std::path::Path::new("/")
        );
        std::fs::write(root.path().join("file"), b"existing").unwrap();
        assert_eq!(
            host_copy_destination(&root.path().join("file/child/output"))
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::NotADirectory
        );
        #[cfg(unix)]
        {
            std::fs::create_dir_all(root.path().join("actual/deep")).unwrap();
            std::os::unix::fs::symlink(canonical.join("actual/deep"), root.path().join("link"))
                .unwrap();
            assert_eq!(
                host_copy_destination(&root.path().join("link/../out")).unwrap(),
                canonical.join("actual/out")
            );
            assert_eq!(
                host_copy_destination(&root.path().join("link//out")).unwrap(),
                canonical.join("actual/deep/out")
            );
        }
    }

    /// The guest reads `source_is_dir` to pick the extraction shape, so an
    /// inverted arm here silently unpacks a directory as a file (or the
    /// reverse) on every peer — Rust, Go and C alike, since all three encode
    /// through this one pair. Pin the encoding itself, not just the round trip:
    /// a round trip survives a consistently inverted mapping.
    #[test]
    fn source_kind_encodes_the_guest_protocol_hint() {
        assert_eq!(CopySourceKind::Unknown.to_wire(), None);
        assert_eq!(CopySourceKind::File.to_wire(), Some(false));
        assert_eq!(CopySourceKind::Dir.to_wire(), Some(true));

        assert_eq!(CopySourceKind::from_wire(None), CopySourceKind::Unknown);
        assert_eq!(CopySourceKind::from_wire(Some(false)), CopySourceKind::File);
        assert_eq!(CopySourceKind::from_wire(Some(true)), CopySourceKind::Dir);
    }

    /// Only `Dir` makes the caller validate recursion — an `Unknown` source
    /// must not be treated as a directory before the guest has peeked.
    #[test]
    fn only_dir_reports_a_directory_source() {
        assert!(CopySourceKind::Dir.is_dir());
        assert!(!CopySourceKind::File.is_dir());
        assert!(!CopySourceKind::Unknown.is_dir());
    }
}
