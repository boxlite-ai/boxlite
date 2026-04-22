//! Per-entry metadata aggregated from tar headers.
//!
//! Tar headers carry several orthogonal pieces of information (mode, times,
//! ownership, device numbers, xattrs). Grouping them here keeps the extractor
//! focused on control flow rather than field plumbing.

use tar::EntryType;

/// Ownership metadata for chown/xattr operations.
pub(super) struct OwnershipMeta {
    pub(super) uid: u64,
    pub(super) gid: u64,
    pub(super) entry_type: EntryType,
    pub(super) device_major: libc::dev_t,
    pub(super) device_minor: libc::dev_t,
    pub(super) xattrs: Vec<(String, Vec<u8>)>,
}

/// Timestamp metadata for time operations.
pub(super) struct TimestampMeta {
    pub(super) atime: u64,
    pub(super) mtime: u64,
}

/// Entry metadata combining ownership, timestamps, and permissions.
pub(super) struct EntryMetadata {
    pub(super) mode: u32,
    pub(super) timestamps: TimestampMeta,
    pub(super) ownership: Option<OwnershipMeta>,
}

impl EntryMetadata {
    /// Create metadata with only timestamps (for directories).
    pub(super) fn with_timestamps(mode: u32, atime: u64, mtime: u64) -> Self {
        Self {
            mode,
            timestamps: TimestampMeta { atime, mtime },
            ownership: None,
        }
    }

    /// Start building full metadata (for files, hardlinks, etc.).
    pub(super) fn builder(mode: u32, atime: u64, mtime: u64) -> EntryMetadataBuilder {
        EntryMetadataBuilder {
            mode,
            atime,
            mtime,
            uid: 0,
            gid: 0,
            entry_type: EntryType::Regular,
            device_major: 0,
            device_minor: 0,
            xattrs: vec![],
        }
    }
}

pub(super) struct EntryMetadataBuilder {
    mode: u32,
    atime: u64,
    mtime: u64,
    uid: u64,
    gid: u64,
    entry_type: EntryType,
    device_major: libc::dev_t,
    device_minor: libc::dev_t,
    xattrs: Vec<(String, Vec<u8>)>,
}

impl EntryMetadataBuilder {
    pub(super) fn uid(mut self, uid: u64) -> Self {
        self.uid = uid;
        self
    }

    pub(super) fn gid(mut self, gid: u64) -> Self {
        self.gid = gid;
        self
    }

    pub(super) fn entry_type(mut self, entry_type: EntryType) -> Self {
        self.entry_type = entry_type;
        self
    }

    pub(super) fn device(mut self, major: libc::dev_t, minor: libc::dev_t) -> Self {
        self.device_major = major;
        self.device_minor = minor;
        self
    }

    pub(super) fn xattrs(mut self, xattrs: Vec<(String, Vec<u8>)>) -> Self {
        self.xattrs = xattrs;
        self
    }

    pub(super) fn build(self) -> EntryMetadata {
        EntryMetadata {
            mode: self.mode,
            timestamps: TimestampMeta {
                atime: self.atime,
                mtime: self.mtime,
            },
            ownership: Some(OwnershipMeta {
                uid: self.uid,
                gid: self.gid,
                entry_type: self.entry_type,
                device_major: self.device_major,
                device_minor: self.device_minor,
                xattrs: self.xattrs,
            }),
        }
    }
}
