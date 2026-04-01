//! Support for `user.containers.override_stat` xattr.
//!
//! This xattr is used by containers/storage for rootless container support.
//! When running without root privileges, actual file ownership (uid/gid) cannot
//! be set. Instead, the intended ownership and permissions are stored in this
//! xattr, and mount programs like fuse-overlayfs read it to present the correct
//! metadata to processes inside the container.
//!
//! Format: `uid:gid:mode:type`
//! - uid: decimal integer
//! - gid: decimal integer
//! - mode: octal (4 digits, e.g., 0755)
//! - type: file, dir, symlink, pipe, socket, block-M-m, char-M-m

#![allow(dead_code)] // parse/read_xattr are for reading layers with existing xattr

use std::path::Path;

/// The xattr name used by containers/storage for override stat.
pub const CONTAINERS_OVERRIDE_XATTR: &str = "user.containers.override_stat";

/// File type for override stat encoding.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OverrideFileType {
    File,
    Dir,
    Symlink,
    Pipe,
    Socket,
    Block { major: u32, minor: u32 },
    Char { major: u32, minor: u32 },
}

impl OverrideFileType {
    /// Convert from tar entry type.
    pub fn from_tar_entry(entry_type: tar::EntryType, major: u32, minor: u32) -> Self {
        match entry_type {
            tar::EntryType::Regular | tar::EntryType::Continuous | tar::EntryType::GNUSparse => {
                Self::File
            }
            tar::EntryType::Directory => Self::Dir,
            tar::EntryType::Symlink => Self::Symlink,
            tar::EntryType::Fifo => Self::Pipe,
            tar::EntryType::Block => Self::Block { major, minor },
            tar::EntryType::Char => Self::Char { major, minor },
            // Treat hardlinks and others as files
            _ => Self::File,
        }
    }

    fn format(&self) -> String {
        match self {
            Self::File => "file".to_string(),
            Self::Dir => "dir".to_string(),
            Self::Symlink => "symlink".to_string(),
            Self::Pipe => "pipe".to_string(),
            Self::Socket => "socket".to_string(),
            Self::Block { major, minor } => format!("block-{}-{}", major, minor),
            Self::Char { major, minor } => format!("char-{}-{}", major, minor),
        }
    }

    fn parse(s: &str) -> Option<Self> {
        match s {
            "file" => Some(Self::File),
            "dir" => Some(Self::Dir),
            "symlink" => Some(Self::Symlink),
            "pipe" => Some(Self::Pipe),
            "socket" => Some(Self::Socket),
            s if s.starts_with("block-") => {
                let rest = &s[6..];
                let mut parts = rest.split('-');
                let major = parts.next()?.parse().ok()?;
                let minor = parts.next()?.parse().ok()?;
                Some(Self::Block { major, minor })
            }
            s if s.starts_with("char-") => {
                let rest = &s[5..];
                let mut parts = rest.split('-');
                let major = parts.next()?.parse().ok()?;
                let minor = parts.next()?.parse().ok()?;
                Some(Self::Char { major, minor })
            }
            _ => None,
        }
    }
}

/// Override stat metadata for rootless container support.
///
/// Stores uid/gid/mode that cannot be applied directly in rootless mode.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverrideStat {
    pub uid: u32,
    pub gid: u32,
    pub mode: u32,
    pub file_type: OverrideFileType,
}

impl OverrideStat {
    /// Create a new OverrideStat.
    pub fn new(uid: u32, gid: u32, mode: u32, file_type: OverrideFileType) -> Self {
        Self {
            uid,
            gid,
            mode,
            file_type,
        }
    }

    /// Format as xattr value string: `uid:gid:mode:type`
    pub fn format(&self) -> String {
        format!(
            "{}:{}:{:04o}:{}",
            self.uid,
            self.gid,
            self.mode & 0o7777,
            self.file_type.format()
        )
    }

    /// Parse from xattr value string.
    pub fn parse(s: &str) -> Option<Self> {
        let parts: Vec<&str> = s.split(':').collect();
        if parts.len() < 4 {
            return None;
        }

        let uid = parts[0].parse().ok()?;
        let gid = parts[1].parse().ok()?;
        let mode = u32::from_str_radix(parts[2], 8).ok()?;
        let file_type = OverrideFileType::parse(parts[3])?;

        Some(Self {
            uid,
            gid,
            mode,
            file_type,
        })
    }

    /// Write this override stat as xattr on the given path.
    pub fn write_xattr(&self, path: &Path) -> std::io::Result<()> {
        xattr::set(path, CONTAINERS_OVERRIDE_XATTR, self.format().as_bytes())
    }

    /// Read override stat from xattr on the given path.
    pub fn read_xattr(path: &Path) -> std::io::Result<Option<Self>> {
        match xattr::get(path, CONTAINERS_OVERRIDE_XATTR)? {
            Some(value) => {
                let s = std::str::from_utf8(&value)
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
                Ok(Self::parse(s))
            }
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_format_file() {
        let stat = OverrideStat::new(1000, 1000, 0o644, OverrideFileType::File);
        assert_eq!(stat.format(), "1000:1000:0644:file");
    }

    #[test]
    fn test_format_dir() {
        let stat = OverrideStat::new(0, 0, 0o755, OverrideFileType::Dir);
        assert_eq!(stat.format(), "0:0:0755:dir");
    }

    #[test]
    fn test_format_symlink() {
        let stat = OverrideStat::new(0, 0, 0o777, OverrideFileType::Symlink);
        assert_eq!(stat.format(), "0:0:0777:symlink");
    }

    #[test]
    fn test_format_block_device() {
        let stat = OverrideStat::new(0, 0, 0o660, OverrideFileType::Block { major: 8, minor: 0 });
        assert_eq!(stat.format(), "0:0:0660:block-8-0");
    }

    #[test]
    fn test_format_char_device() {
        let stat = OverrideStat::new(0, 0, 0o666, OverrideFileType::Char { major: 1, minor: 3 });
        assert_eq!(stat.format(), "0:0:0666:char-1-3");
    }

    #[test]
    fn test_parse_file() {
        let stat = OverrideStat::parse("1000:1000:0644:file").unwrap();
        assert_eq!(stat.uid, 1000);
        assert_eq!(stat.gid, 1000);
        assert_eq!(stat.mode, 0o644);
        assert_eq!(stat.file_type, OverrideFileType::File);
    }

    #[test]
    fn test_parse_dir() {
        let stat = OverrideStat::parse("0:0:0755:dir").unwrap();
        assert_eq!(stat.uid, 0);
        assert_eq!(stat.gid, 0);
        assert_eq!(stat.mode, 0o755);
        assert_eq!(stat.file_type, OverrideFileType::Dir);
    }

    #[test]
    fn test_parse_block_device() {
        let stat = OverrideStat::parse("0:0:0660:block-8-0").unwrap();
        assert_eq!(
            stat.file_type,
            OverrideFileType::Block { major: 8, minor: 0 }
        );
    }

    #[test]
    fn test_parse_char_device() {
        let stat = OverrideStat::parse("0:0:0666:char-1-3").unwrap();
        assert_eq!(
            stat.file_type,
            OverrideFileType::Char { major: 1, minor: 3 }
        );
    }

    #[test]
    fn test_roundtrip() {
        let original = OverrideStat::new(1000, 1000, 0o755, OverrideFileType::Dir);
        let formatted = original.format();
        let parsed = OverrideStat::parse(&formatted).unwrap();
        assert_eq!(original, parsed);
    }

    #[test]
    fn test_parse_invalid() {
        assert!(OverrideStat::parse("").is_none());
        assert!(OverrideStat::parse("1000:1000").is_none());
        assert!(OverrideStat::parse("invalid:invalid:invalid:invalid").is_none());
    }
}
