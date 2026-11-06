//! Private managed transfer. Public pair archives remain a different format.

use super::{Catalog, CheckpointInfo};
use crate::litebox::checkpoint::pair::{self, invalid};
use crate::{BoxliteError, BoxliteResult};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

const MEMBERS: [&str; 3] = ["pair/snapshot.mem", "pair/snapshot.qcow2", "boot.raw"];
const MANIFEST_LIMIT: u64 = 64 * 1024;
// A hard transport ceiling, independent of untrusted tar/manifest claims.
const MEMBER_LIMIT: u64 = 16 * 1024 * 1024 * 1024 * 1024;

fn require_space(directory: &Path, length: u64) -> BoxliteResult<()> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(directory.as_os_str().as_bytes()).map_err(invalid)?;
    let mut stats = std::mem::MaybeUninit::<libc::statvfs>::uninit();
    // SAFETY: path is NUL-terminated and stats points to writable statvfs storage.
    if unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return Err(invalid(std::io::Error::last_os_error()));
    }
    // SAFETY: a successful statvfs call initialized every field.
    let stats = unsafe { stats.assume_init() };
    let available = u128::from(stats.f_bavail) * u128::from(stats.f_frsize);
    if u128::from(length) + (1 << 20) > available {
        return Err(BoxliteError::ResourceExhausted(
            "managed checkpoint archive exceeds available staging space".into(),
        ));
    }
    Ok(())
}

#[derive(Serialize, Deserialize, PartialEq, Eq)]
struct Member {
    length: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    sha256: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Manifest {
    version: u32,
    checkpoint: CheckpointInfo,
    members: BTreeMap<String, Member>,
    #[serde(default)]
    metadata_sha256: String,
}

fn members(directory: &Path) -> BoxliteResult<BTreeMap<String, Member>> {
    MEMBERS
        .into_iter()
        .map(|name| {
            let file = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(directory.join(name))
                .map_err(invalid)?;
            let metadata = file.metadata().map_err(invalid)?;
            if !metadata.is_file() || metadata.len() > MEMBER_LIMIT {
                return Err(invalid("invalid managed member size or type"));
            }
            Ok((
                name.to_owned(),
                Member {
                    length: metadata.len(),
                    sha256: None,
                },
            ))
        })
        .collect()
}

pub(super) fn replay_identity(directory: &Path) -> BoxliteResult<String> {
    use sha2::{Digest, Sha256};
    let identity = pair::open(&directory.join("pair"))?.metadata_identity()?;
    let bytes = serde_json::to_vec(&(identity, members(directory)?)).map_err(invalid)?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

pub(super) fn pack(
    directory: &Path,
    info: &CheckpointInfo,
    destination: &Path,
) -> BoxliteResult<()> {
    let pair = pair::open(&directory.join("pair"))?;
    pair.verify_disk()?;
    let mut members = members(directory)?;
    if members["boot.raw"].length != pair.dependencies.boot_disk_bytes {
        return Err(invalid("managed boot dependency length mismatch"));
    }
    members.get_mut("boot.raw").unwrap().sha256 = Some(pair.dependencies.boot_disk_sha256.clone());
    let manifest = Manifest {
        version: 2,
        checkpoint: info.clone(),
        members,
        metadata_sha256: pair.metadata_identity()?,
    };
    let bytes = serde_json::to_vec(&manifest).map_err(invalid)?;
    let parent = destination
        .parent()
        .filter(|path| !path.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let mut staging = tempfile::NamedTempFile::new_in(parent).map_err(invalid)?;
    {
        let mut encoder =
            zstd::stream::write::Encoder::new(staging.as_file_mut(), 1).map_err(invalid)?;
        encoder.include_checksum(false).map_err(invalid)?;
        let mut archive = tar::Builder::new(encoder);
        append(
            &mut archive,
            "manifest.json",
            bytes.len() as u64,
            bytes.as_slice(),
        )?;
        for name in MEMBERS {
            let file = File::open(directory.join(name)).map_err(invalid)?;
            append(
                &mut archive,
                name,
                file.metadata().map_err(invalid)?.len(),
                file,
            )?;
        }
        archive
            .into_inner()
            .map_err(invalid)?
            .finish()
            .map_err(invalid)?;
    }
    staging.as_file().sync_all().map_err(invalid)?;
    staging.persist_noclobber(destination).map_err(invalid)?;
    File::open(parent)
        .and_then(|file| file.sync_all())
        .map_err(invalid)
}

fn append<W: Write>(
    archive: &mut tar::Builder<W>,
    name: &str,
    length: u64,
    file: impl Read,
) -> BoxliteResult<()> {
    let mut header = tar::Header::new_ustar();
    header.set_size(length);
    header.set_mode(0o600);
    header.set_entry_type(tar::EntryType::Regular);
    header.set_cksum();
    archive
        .append_data(&mut header, name, file)
        .map_err(invalid)
}

pub(super) fn unpack(
    catalog: &Catalog,
    source: &Path,
    operation: &str,
) -> BoxliteResult<CheckpointInfo> {
    let stage = tempfile::Builder::new()
        .prefix(".archive-")
        .tempdir_in(&catalog.root)
        .map_err(invalid)?;
    std::fs::create_dir(stage.path().join("pair")).map_err(invalid)?;
    let input = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(source)
        .map_err(invalid)?;
    let mut decoder = zstd::stream::read::Decoder::new(input).map_err(invalid)?;
    decoder
        .set_parameter(zstd::zstd_safe::DParameter::ForceIgnoreChecksum(true))
        .map_err(invalid)?;
    let mut archive = tar::Archive::new(decoder);
    let mut seen = std::collections::BTreeSet::new();
    let mut manifest = None;
    for entry in archive.entries().map_err(invalid)?.raw(true) {
        let mut entry = entry.map_err(invalid)?;
        let name = match entry.path_bytes().as_ref() {
            b"manifest.json" => "manifest.json",
            b"pair/snapshot.mem" => MEMBERS[0],
            b"pair/snapshot.qcow2" => MEMBERS[1],
            b"boot.raw" => MEMBERS[2],
            _ => return Err(invalid("extra or invalid managed archive member")),
        };
        if entry.header().entry_type() != tar::EntryType::Regular || !seen.insert(name) {
            return Err(invalid("duplicate or nonregular managed archive member"));
        }
        let length = entry.size();
        if length
            > if name == "manifest.json" {
                MANIFEST_LIMIT
            } else {
                MEMBER_LIMIT
            }
        {
            return Err(invalid("managed archive member exceeds size limit"));
        }
        if name == "manifest.json" {
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).map_err(invalid)?;
            manifest = Some(serde_json::from_slice::<Manifest>(&bytes).map_err(invalid)?);
        } else {
            require_space(stage.path(), length)?;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(stage.path().join(name))
                .map_err(invalid)?;
            if std::io::copy(&mut entry, &mut output).map_err(invalid)? != length {
                return Err(invalid("incomplete managed archive member"));
            }
            output.sync_all().map_err(invalid)?;
        }
    }
    let mut decoder = archive.into_inner();
    let mut buffer = [0; 8192];
    let mut tail = 0;
    loop {
        let count = decoder.read(&mut buffer).map_err(invalid)?;
        if count == 0 {
            break;
        }
        tail += count;
        if tail > 65536 || buffer[..count].iter().any(|byte| *byte != 0) {
            return Err(invalid("invalid managed archive trailer"));
        }
    }
    if tail < 512 || tail % 512 != 0 || seen.len() != 4 {
        return Err(invalid("incomplete managed archive"));
    }
    let manifest = manifest.ok_or_else(|| invalid("missing managed manifest"))?;
    let actual = members(stage.path())?;
    if !matches!(manifest.version, 1 | 2)
        || manifest.members.len() != actual.len()
        || actual.iter().any(|(name, member)| {
            manifest
                .members
                .get(name)
                .is_none_or(|saved| saved.length != member.length)
        })
    {
        return Err(invalid(
            "managed manifest version or member length mismatch",
        ));
    }
    let pair = pair::open(&stage.path().join("pair"))?;
    pair.verify_disk()?;
    if manifest.version == 2 && manifest.metadata_sha256 != pair.metadata_identity()? {
        return Err(invalid("managed checkpoint metadata identity mismatch"));
    }
    if actual["boot.raw"].length != pair.dependencies.boot_disk_bytes {
        return Err(invalid("managed boot dependency length mismatch"));
    }
    if manifest.members["boot.raw"].sha256.as_deref() != Some(&pair.dependencies.boot_disk_sha256) {
        return Err(invalid("managed boot dependency identity mismatch"));
    }
    let resources: crate::BoxResources =
        serde_json::from_value(pair.dependencies.application["resources"].clone())
            .map_err(invalid)?;
    pair::validate_resources(resources, &pair.dependencies)?;
    if pair.dependencies.application["local_paths"]["version"] != 2 {
        return Err(invalid(
            "managed checkpoint requires relocatable path metadata v2",
        ));
    }
    if manifest.checkpoint.cpus != u16::from(resources.cpus)
        || manifest.checkpoint.memory_bytes != pair.dependencies.memory_bytes
        || manifest.checkpoint.container_disk_bytes != pair.dependencies.container_disk_bytes
    {
        return Err(invalid(
            "managed resource metadata differs from native checkpoint",
        ));
    }
    drop(pair);
    if let Some(existing) = catalog.store.get(None, operation)? {
        if existing.id != operation
            || existing.status != "ready"
            || replay_identity(&catalog.directory(operation)?)? != replay_identity(stage.path())?
        {
            return Err(BoxliteError::InvalidState(
                "managed import operation already names different content or state".into(),
            ));
        }
        return Ok(existing);
    }
    let mut info = manifest.checkpoint;
    if crate::BoxID::parse(&info.box_id).is_none() {
        return Err(invalid("invalid managed source box identity"));
    }
    info.id = operation.to_owned();
    info.name = format!("import-{operation}");
    info.status = "creating".into();
    info.error = None;
    info.size_bytes = manifest.members.values().try_fold(0u64, |total, member| {
        total
            .checked_add(member.length)
            .ok_or_else(|| invalid("managed size overflow"))
    })?;
    catalog.publish_import(stage, info)
}
