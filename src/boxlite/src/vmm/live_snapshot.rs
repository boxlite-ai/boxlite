//! Runtime and shim protocol for pivoting the writable container disk.

use std::io;
use std::os::unix::fs::MetadataExt;
use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub(crate) const FENCE_WINDOW: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct FileId {
    pub(crate) device: u64,
    pub(crate) inode: u64,
}

impl FileId {
    pub(crate) fn at(path: &Path) -> io::Result<Self> {
        let entry = std::fs::symlink_metadata(path)?;
        if !entry.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "expected a regular disk file",
            ));
        }
        Ok(Self {
            device: entry.dev(),
            inode: entry.ino(),
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum Phase {
    Absent,
    Fenced,
    Installed,
    Committed,
    Aborted,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Request {
    pub transaction: String,
    pub command: Command,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum Command {
    Status,
    Fence {
        source: FileId,
        deadline: u64,
    },
    Install {
        source: FileId,
        overlay: FileId,
        snapshot: String,
    },
    Release {
        overlay: FileId,
    },
    Abort {
        source: FileId,
    },
}

pub(crate) fn monotonic_nanos() -> u64 {
    let mut time = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: time is valid writable storage and CLOCK_MONOTONIC is supported on both hosts.
    assert_eq!(
        unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut time) },
        0
    );
    (time.tv_sec as u64).saturating_mul(1_000_000_000) + time.tv_nsec as u64
}
