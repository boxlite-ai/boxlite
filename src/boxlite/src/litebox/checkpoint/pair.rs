//! Version-9 pair verification. Verified descriptors stay pinned through use.
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

pub const MEMORY: &str = "snapshot.mem";
pub const DISK: &str = "snapshot.qcow2";
const HEADER: u64 = 160;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ObjectReference {
    pub resource_id: String,
    pub recovery_point: String,
    pub object_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectDependency {
    /// Opaque identity shared by aliases across filesystem shares.
    pub alias: u64,
    pub guest_ino: u64,
    pub ctime: (i64, i64),
    pub kind: u32,
    /// True only for a regular file already unlinked at capture.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub unlinked: bool,
    pub reference: Option<ObjectReference>,
    pub recipe: Option<String>,
}

impl ObjectDependency {
    pub(crate) fn allows_missing(&self) -> bool {
        self.unlinked
            && self.kind == 0o100000 // S_IFREG, independent of the host's mode_t width.
            && self.recipe.is_none()
            && self.reference.is_some()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShareDependency {
    pub tag: String,
    pub vm_owned: bool,
    pub read_only: bool,
    pub objects: Vec<ObjectDependency>,
    /// Saved handle IDs, status flags, directory cursors and DAX access roles.
    pub state: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct CheckpointDependencies {
    pub version: u32,
    pub cpus: u16,
    pub memory_bytes: u64,
    pub container_disk_bytes: u64,
    pub boot_disk_bytes: u64,
    pub boot_disk_sha256: String,
    pub qcow2_bytes: u64,
    pub qcow2_sha256: String,
    pub shares: Vec<ShareDependency>,
    pub disk_dependencies: serde_json::Value,
    #[serde(skip_serializing)]
    pub(crate) application: serde_json::Value,
}

pub(crate) struct VerifiedPair {
    pub memory: File,
    pub disk: File,
    pub dependencies: CheckpointDependencies,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Application {
    pub source_box_id: String,
    pub guest: super::GuestIdentity,
    pub options: crate::BoxOptions,
    pub container_image_config: crate::images::ContainerImageConfig,
    pub outbound_policy: Option<crate::runtime::options::OutboundNetworkConfig>,
}

pub(crate) fn invalid(message: impl std::fmt::Display) -> BoxliteError {
    BoxliteError::Storage(format!("invalid checkpoint: {message}"))
}

pub(crate) fn digest(file: &File, offset: u64, length: u64) -> BoxliteResult<[u8; 32]> {
    use std::os::unix::fs::FileExt;
    let mut hash = Sha256::new();
    let mut buffer = vec![0; 1 << 20];
    let mut done = 0;
    while done < length {
        let count = (length - done).min(buffer.len() as u64) as usize;
        file.read_exact_at(
            &mut buffer[..count],
            offset
                .checked_add(done)
                .ok_or_else(|| invalid("digest overflow"))?,
        )
        .map_err(invalid)?;
        hash.update(&buffer[..count]);
        done += count as u64;
    }
    Ok(hash.finalize().into())
}

pub(crate) fn shares(metadata: &serde_json::Value) -> BoxliteResult<Vec<ShareDependency>> {
    if metadata.is_null() {
        return Ok(Vec::new());
    }
    let devices = metadata["devices"]
        .as_array()
        .ok_or_else(|| invalid("share devices missing"))?;
    let sessions = metadata["sessions"]
        .as_array()
        .ok_or_else(|| invalid("share sessions missing"))?;
    if devices.len() != sessions.len() || devices.len() > 7 {
        return Err(invalid("share count mismatch"));
    }
    devices
        .iter()
        .zip(sessions)
        .map(|(device, session)| {
            Ok(ShareDependency {
                tag: serde_json::from_value(device["tag"].clone()).map_err(invalid)?,
                vm_owned: serde_json::from_value(device["vm_owned"].clone()).map_err(invalid)?,
                read_only: serde_json::from_value(device["read_only"].clone()).map_err(invalid)?,
                objects: serde_json::from_value(session["objects"].clone()).map_err(invalid)?,
                state: session["state"].clone(),
            })
        })
        .collect()
}

fn validate_extents(metadata: &serde_json::Value, payload: u64) -> BoxliteResult<u64> {
    let fields = [
        "compatibility",
        "cpus",
        "vm",
        "regions",
        "disks",
        "nic",
        "rng",
        "balloon",
        "vsock",
        "console",
        "legacy",
        "fs",
        "application_schema",
        "application",
        "disk_dependencies",
    ];
    let object = metadata
        .as_object()
        .ok_or_else(|| invalid("metadata must be an object"))?;
    if object.keys().any(|key| !fields.contains(&key.as_str()))
        || fields.iter().any(|key| !object.contains_key(*key))
    {
        return Err(invalid("missing or unknown required metadata section"));
    }
    let cpus = metadata["cpus"]
        .as_array()
        .ok_or_else(|| invalid("CPU table missing"))?;
    if cpus.is_empty() || cpus.len() > 128 {
        return Err(invalid("unsupported CPU count"));
    }
    let regions = metadata["regions"]
        .as_array()
        .ok_or_else(|| invalid("RAM regions missing"))?;
    if regions.is_empty() {
        return Err(invalid("RAM regions empty"));
    }
    let (mut previous, mut bytes) = (0u64, 0u64);
    for region in regions {
        let address = region["gpa"]
            .as_u64()
            .ok_or_else(|| invalid("invalid RAM address"))?;
        let length = region["len"]
            .as_u64()
            .ok_or_else(|| invalid("invalid RAM length"))?;
        if length == 0
            || length > isize::MAX as u64
            || address % 4096 != 0
            || length % 4096 != 0
            || address < previous
            || region["attributes"] != 0
        {
            return Err(invalid(
                "RAM regions overlap or have unsupported alignment/attributes",
            ));
        }
        previous = address
            .checked_add(length)
            .ok_or_else(|| invalid("RAM address overflow"))?;
        bytes = bytes
            .checked_add(length)
            .ok_or_else(|| invalid("RAM payload overflow"))?;
    }
    let ram_bytes = bytes;
    if let Some(fs) = metadata["fs"].as_object() {
        let sessions = fs
            .get("sessions")
            .and_then(|v| v.as_array())
            .ok_or_else(|| invalid("FUSE sessions missing"))?;
        for session in sessions {
            let init = session["init_len"]
                .as_u64()
                .ok_or_else(|| invalid("invalid init extent"))?;
            if init > 64 << 20 {
                return Err(invalid("init extent exceeds bound"));
            }
            let offsets = session["dax_offsets"]
                .as_array()
                .ok_or_else(|| invalid("DAX extents missing"))?;
            let mut previous = None;
            let window = session["state"]["dax"]["size"].as_u64().unwrap_or(0);
            for offset in offsets {
                let offset = offset
                    .as_u64()
                    .ok_or_else(|| invalid("invalid DAX extent"))?;
                if offset % 4096 != 0
                    || previous.is_some_and(|value| offset <= value)
                    || offset.checked_add(4096).is_none_or(|end| end > window)
                {
                    return Err(invalid(
                        "anonymous DAX extents overlap or exceed their window",
                    ));
                }
                previous = Some(offset);
            }
            bytes = bytes
                .checked_add(init)
                .and_then(|value| value.checked_add((offsets.len() as u64).checked_mul(4096)?))
                .ok_or_else(|| invalid("FUSE payload overflow"))?;
        }
    }
    if bytes != payload {
        return Err(invalid("memory payload extents differ from metadata"));
    }
    let disks = metadata["disks"]
        .as_array()
        .ok_or_else(|| invalid("disk table missing"))?;
    let dependencies = metadata["disk_dependencies"]
        .as_array()
        .ok_or_else(|| invalid("disk dependencies missing"))?;
    if disks.len() != 2
        || dependencies.len() != 2
        || dependencies[0] != "container_qcow2"
        || !dependencies[1]["external_readonly_boot"].is_object()
        || disks[0]["read_only"] != false
        || disks[1]["read_only"] != true
    {
        return Err(invalid("container/readonly boot disk layout differs"));
    }
    Ok(ram_bytes)
}

pub(crate) fn inspect_memory(mut memory: &File) -> BoxliteResult<CheckpointDependencies> {
    memory.seek(SeekFrom::Start(0)).map_err(invalid)?;
    let mut prefix = [0; 12];
    memory.read_exact(&mut prefix).map_err(invalid)?;
    if &prefix[..8] != b"KRUNVM\0\0" {
        return Err(invalid(
            "unsupported checkpoint version/format; version 9 directory required",
        ));
    }
    if u32::from_le_bytes(prefix[8..].try_into().unwrap()) != 9 {
        return Err(invalid(
            "unsupported checkpoint version; version 9 required",
        ));
    }
    memory.seek(SeekFrom::Start(0)).map_err(invalid)?;
    let mut header = [0; HEADER as usize];
    memory.read_exact(&mut header).map_err(invalid)?;
    let number = |offset| u64::from_le_bytes(header[offset..offset + 8].try_into().unwrap());
    let (total, metadata_bytes, payload_bytes) = (number(16), number(24), number(32));
    if u32::from_le_bytes(header[12..16].try_into().unwrap()) != HEADER as u32
        || header[144..].iter().any(|&b| b != 0)
        || metadata_bytes == 0
        || metadata_bytes > 16 << 20
        || HEADER
            .checked_add(metadata_bytes)
            .and_then(|n| n.checked_add(payload_bytes))
            != Some(total)
        || memory.metadata().map_err(invalid)?.len() != total
    {
        return Err(invalid("memory envelope bounds/reserved fields mismatch"));
    }
    if digest(memory, HEADER, metadata_bytes)? != header[48..80]
        || digest(memory, HEADER + metadata_bytes, payload_bytes)? != header[80..112]
    {
        return Err(invalid("memory checksum mismatch"));
    }
    let mut bytes = vec![0; metadata_bytes as usize];
    memory.read_exact(&mut bytes).map_err(invalid)?;
    let metadata: serde_json::Value = serde_json::from_slice(&bytes).map_err(invalid)?;
    if metadata["application_schema"] != 1 {
        return Err(invalid("unsupported application schema"));
    }
    let memory_bytes = validate_extents(&metadata, payload_bytes)?;
    let boot = &metadata["disk_dependencies"][1]["external_readonly_boot"];
    let boot_hash: [u8; 32] = serde_json::from_value(boot["sha256"].clone()).map_err(invalid)?;
    Ok(CheckpointDependencies {
        version: 9,
        cpus: metadata["cpus"]
            .as_array()
            .expect("validated CPU table")
            .len() as u16,
        memory_bytes,
        container_disk_bytes: metadata["disks"][0]["disk_bytes"]
            .as_u64()
            .ok_or_else(|| invalid("container capacity missing"))?,
        boot_disk_bytes: boot["length"]
            .as_u64()
            .ok_or_else(|| invalid("boot physical length missing"))?,
        boot_disk_sha256: hex::encode(boot_hash),
        qcow2_bytes: number(40),
        qcow2_sha256: hex::encode(&header[112..144]),
        shares: shares(&metadata["fs"])?,
        disk_dependencies: metadata["disk_dependencies"].clone(),
        application: metadata["application"].clone(),
    })
}

pub(crate) fn open(path: &Path) -> BoxliteResult<VerifiedPair> {
    if !std::fs::symlink_metadata(path).map_err(invalid)?.is_dir() {
        return Err(invalid(
            "unsupported checkpoint version/format; version 9 two-file directory required",
        ));
    }
    let directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(path)
        .map_err(invalid)?;
    let mut names = directory_names(&directory)?;
    names.sort();
    if names
        != [
            std::ffi::OsString::from(MEMORY),
            std::ffi::OsString::from(DISK),
        ]
    {
        return Err(invalid(
            "directory must contain exactly snapshot.mem and snapshot.qcow2",
        ));
    }
    // Pin the directory and open both children relative to it, avoiding a
    // destination replacement redirect between validation and use.
    let child = |name: &str| -> BoxliteResult<File> {
        use std::os::fd::{AsRawFd, FromRawFd};
        let name = std::ffi::CString::new(name).expect("fixed filename");
        // SAFETY: name is terminated and directory remains a live FD.
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(invalid(std::io::Error::last_os_error()));
        }
        // SAFETY: openat returned a new owned descriptor.
        let file = unsafe { File::from_raw_fd(fd) };
        if !file.metadata().map_err(invalid)?.is_file() {
            return Err(invalid("pair child is not a regular file"));
        }
        Ok(file)
    };
    let memory = child(MEMORY)?;
    let disk = child(DISK)?;
    let dependencies = inspect_memory(&memory)?;
    Ok(VerifiedPair {
        memory,
        disk,
        dependencies,
    })
}

fn directory_names(directory: &File) -> BoxliteResult<Vec<std::ffi::OsString>> {
    use std::os::fd::{FromRawFd, IntoRawFd};
    use std::os::unix::ffi::OsStringExt;
    let fd = directory.try_clone().map_err(invalid)?.into_raw_fd();
    // SAFETY: fd is a new owned directory descriptor, transferred on success.
    let stream = unsafe { libc::fdopendir(fd) };
    if stream.is_null() {
        let error = std::io::Error::last_os_error();
        // SAFETY: fdopendir did not consume fd on failure.
        drop(unsafe { File::from_raw_fd(fd) });
        return Err(invalid(error));
    }
    struct Entries(*mut libc::DIR);
    impl Drop for Entries {
        fn drop(&mut self) {
            unsafe { libc::closedir(self.0) };
        }
    }
    let entries = Entries(stream);
    let mut names = Vec::new();
    loop {
        #[cfg(target_os = "linux")]
        let errno = unsafe { libc::__errno_location() };
        #[cfg(not(target_os = "linux"))]
        let errno = unsafe { libc::__error() };
        // SAFETY: errno is thread-local; the live DIR owns the returned entry
        // until the next readdir. POSIX guarantees its name is NUL-terminated.
        unsafe {
            *errno = 0;
            let entry = libc::readdir(entries.0);
            if entry.is_null() {
                if *errno != 0 {
                    return Err(invalid(std::io::Error::last_os_error()));
                }
                break;
            }
            let name = std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()).to_bytes();
            if name != b"." && name != b".." {
                names.push(std::ffi::OsString::from_vec(name.to_vec()));
            }
        }
    }
    Ok(names)
}

impl VerifiedPair {
    pub fn verify_disk(&self) -> BoxliteResult<()> {
        if self.disk.metadata().map_err(invalid)?.len() != self.dependencies.qcow2_bytes
            || hex::encode(digest(&self.disk, 0, self.dependencies.qcow2_bytes)?)
                != self.dependencies.qcow2_sha256
        {
            return Err(invalid("paired QCOW2 length/checksum mismatch"));
        }
        use std::os::unix::fs::FileExt;
        let mut header = [0; 104];
        self.disk.read_exact_at(&mut header, 0).map_err(invalid)?;
        if u64::from_be_bytes(header[24..32].try_into().unwrap())
            != self.dependencies.container_disk_bytes
        {
            return Err(invalid("QCOW2 capacity differs from saved device"));
        }
        if &header[..4] != b"QFI\xfb"
            || !matches!(u32::from_be_bytes(header[4..8].try_into().unwrap()), 2 | 3)
            || header[8..20].iter().any(|&b| b != 0)
            || (header[4..8] == 3u32.to_be_bytes() && header[72..80].iter().any(|&b| b != 0))
        {
            return Err(invalid("container must be standalone QCOW2"));
        }
        Ok(())
    }
}

#[cfg(test)]
#[path = "tests/pair.rs"]
mod tests;
