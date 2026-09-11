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

#[cfg(test)]
mod tests {
    use super::*;

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
