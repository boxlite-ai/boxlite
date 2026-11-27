// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The mounts a snapshot records for each export.
//!
//! A host file is identified by its device, its inode and the mount it was
//! reached through. Mount IDs belong to one mount instance and change when a
//! VM is restored, so a snapshot keeps where each mount sits relative to the
//! export root, and restore opens that path again to learn the new ID.

use std::collections::BTreeMap;
use std::io;

use super::super::fs_utils::einval;

#[cfg(test)]
thread_local! {
    static MOUNTINFO: std::cell::RefCell<Option<Result<Vec<u8>, io::ErrorKind>>> =
        const { std::cell::RefCell::new(None) };
}

/// Replaces [`read_mountinfo`] on this thread until the returned guard drops.
/// Tests model bind mounts and an unreadable table with it.
#[cfg(test)]
pub(crate) fn replace_mountinfo(table: Result<Vec<u8>, io::ErrorKind>) -> impl Drop {
    struct Replaced;
    impl Drop for Replaced {
        fn drop(&mut self) {
            MOUNTINFO.with(|slot| *slot.borrow_mut() = None);
        }
    }
    MOUNTINFO.with(|slot| *slot.borrow_mut() = Some(table));
    Replaced
}

/// The mount table of this process, as `/proc/self/mountinfo` reports it.
pub(crate) fn read_mountinfo() -> io::Result<Vec<u8>> {
    #[cfg(test)]
    if let Some(table) = MOUNTINFO.with(|slot| slot.borrow().clone()) {
        return table.map_err(io::Error::from);
    }
    std::fs::read("/proc/self/mountinfo")
}

/// Parses `/proc/self/mountinfo` into mount ID → mount point. The kernel's escapes are decoded.
pub(crate) fn parse_mountinfo(text: &[u8]) -> io::Result<BTreeMap<u64, Vec<u8>>> {
    let mut table = BTreeMap::new();
    for line in text
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let mut fields = line.split(|byte| *byte == b' ');
        let id = fields
            .next()
            .and_then(|id| std::str::from_utf8(id).ok())
            .and_then(|id| id.parse().ok())
            .ok_or_else(einval)?;
        // Fields 2 to 4 are the parent ID, the device and the path within the filesystem.
        let point = unescape(fields.nth(3).ok_or_else(einval)?)?;
        table.insert(id, point);
    }
    Ok(table)
}

/// Decodes the four escapes `/proc/self/mountinfo` uses: space, tab, newline and backslash.
fn unescape(field: &[u8]) -> io::Result<Vec<u8>> {
    let mut point = Vec::with_capacity(field.len());
    let mut rest = field;
    while let Some(position) = rest.iter().position(|byte| *byte == b'\\') {
        point.extend_from_slice(&rest[..position]);
        let digits = rest.get(position + 1..position + 4).ok_or_else(einval)?;
        let value = u8::from_str_radix(std::str::from_utf8(digits).map_err(|_| einval())?, 8)
            .map_err(|_| einval())?;
        point.push(value);
        rest = &rest[position + 4..];
    }
    point.extend_from_slice(rest);
    Ok(point)
}

/// The components of `path` below `prefix`, or `None` when `path` lies elsewhere.
///
/// Both are absolute, resolved paths. An equal path yields no components.
pub(crate) fn beneath(prefix: &[u8], path: &[u8]) -> Option<Vec<Vec<u8>>> {
    if path == prefix {
        return Some(Vec::new());
    }
    let root = prefix.strip_suffix(b"/").unwrap_or(prefix);
    let rest = path.strip_prefix(root)?.strip_prefix(b"/")?;
    (!rest.is_empty()).then(|| {
        rest.split(|byte| *byte == b'/')
            .map(<[u8]>::to_vec)
            .collect()
    })
}

/// The path of the mount point `point` inside the export rooted at `root`.
///
/// An empty path names the mount the export root is on, whether the mount point
/// is the root itself or one of its ancestors. [`einval`] reports a mount
/// point outside the export, which no node below the root can be on.
pub(crate) fn mount_path(root: &[u8], point: &[u8]) -> io::Result<Vec<Vec<u8>>> {
    match beneath(root, point) {
        Some(path) => Ok(path),
        None if beneath(point, root).is_some() => Ok(Vec::new()),
        None => Err(einval()),
    }
}
