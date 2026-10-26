//! The BoxCheckpoint file: one paused VM, standalone.
//!
//! A plain tar with exactly two regular members, in this order:
//! `checkpoint.json`, the [`Manifest`], and `vm.krunvm`, libkrun's KRUNVM
//! image of the paused VM with its disks and shares inside. The manifest
//! records the image's length and SHA-256, the device layout the image must
//! have, the guest the pause cut, and what a cold start of the restored box
//! needs. Nothing in it is read from the source host on import.
//!
//! Reading trusts nothing: any other member, member type, order, length or
//! checksum is refused, and the image's own metadata must show the layout
//! the manifest claims.

use super::GuestIdentity;
use crate::images::ContainerImageConfig;
use crate::runtime::constants::mount_tags;
use crate::runtime::constants::vm_defaults::DEFAULT_CPUS;
use crate::runtime::options::{BoxOptions, NetworkSpec, OutboundNetworkConfig};
use crate::vmm::checkpoint::DAX_WINDOW_BYTES;
use boxlite_shared::constants::network::{GUEST_AGENT_PORT, GUEST_READY_PORT};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

pub(crate) const FORMAT: &str = "boxlite-checkpoint";
/// The manifest version this build writes and the only one it reads.
pub(crate) const VERSION: u32 = 1;
/// The libkrun image version this build writes and imports.
pub(crate) const KRUNVM_VERSION: u32 = 8;
const MANIFEST_MEMBER: &str = "checkpoint.json";
const IMAGE_MEMBER: &str = "vm.krunvm";
const MAX_MANIFEST_BYTES: u64 = 1 << 20;
const KRUNVM_MAGIC: &[u8; 8] = b"KRUNVM\0\0";
const KRUNVM_HEADER: u64 = 16;
const MAX_KRUNVM_METADATA: u64 = 16 << 20;
/// A tar block; each header and member is padded to it.
const TAR_BLOCK: u64 = 512;
/// The tar end marker: two zero blocks.
const TAR_END: u64 = 2 * TAR_BLOCK;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Manifest {
    pub(crate) format: String,
    pub(crate) version: u32,
    pub(crate) created_at: DateTime<Utc>,
    /// Informational: the box the checkpoint was taken from.
    pub(crate) source_box_id: String,
    /// The guest the pause cut; the restored box resumes only into it.
    pub(crate) guest: GuestIdentity,
    pub(crate) image: ImageRecord,
    pub(crate) layout: DeviceLayout,
    pub(crate) boot: BootRecord,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ImageRecord {
    pub(crate) krunvm_version: u32,
    pub(crate) length: u64,
    /// `sha256:<hex>`.
    pub(crate) sha256: String,
}

/// The devices of a checkpointed VM, as its image records them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DeviceLayout {
    pub(crate) vcpus: usize,
    pub(crate) ram_bytes: u64,
    /// In guest order.
    pub(crate) disks: Vec<DiskLayout>,
    /// The shares the restored box keeps, in device order. The VM-owned
    /// boot root is counted, not listed: its copy goes with the VM.
    pub(crate) shares: Vec<ShareLayout>,
    pub(crate) vm_owned_shares: usize,
    pub(crate) nic_mac: Option<[u8; 6]>,
    pub(crate) vsock_ports: Vec<VsockPort>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DiskLayout {
    pub(crate) read_only: bool,
    pub(crate) bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ShareLayout {
    pub(crate) tag: String,
    pub(crate) read_only: bool,
    /// The share's DAX window; 0 for none.
    pub(crate) dax_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct VsockPort {
    pub(crate) port: u32,
    pub(crate) listen: bool,
}

/// What a cold start of the restored box needs besides its storage.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct BootRecord {
    pub(crate) options: BoxOptions,
    pub(crate) outbound_policy: Option<OutboundNetworkConfig>,
    pub(crate) container_image_config: ContainerImageConfig,
}

fn invalid(why: impl std::fmt::Display) -> BoxliteError {
    BoxliteError::Storage(format!("invalid checkpoint: {why}"))
}

/// The user-volume share tag of volume `index` (see `resolve_user_volumes`).
pub(crate) fn volume_tag(index: usize) -> String {
    format!("uservol{index}")
}

impl DeviceLayout {
    /// Fail unless this is the layout a box with `options` boots: the
    /// container disk and the read-only guest rootfs, the box's `shared/`
    /// tree plus one share per volume, each with the checkpoint DAX window,
    /// and the VM-owned boot root, a gvproxy
    /// NIC exactly when networking is on, and the agent's vsock ports.
    pub(crate) fn check_for(&self, options: &BoxOptions) -> BoxliteResult<()> {
        let cpus = usize::from(options.cpus.unwrap_or(DEFAULT_CPUS));
        if self.vcpus != cpus {
            return Err(invalid(format_args!(
                "the image has {} vCPUs, the box {cpus}",
                self.vcpus
            )));
        }
        let read_only: Vec<bool> = self.disks.iter().map(|disk| disk.read_only).collect();
        if read_only != [false, true] {
            return Err(invalid(format_args!(
                "the image's disks {:?} are not the container disk and the guest rootfs",
                self.disks
            )));
        }
        let mut shares = vec![ShareLayout {
            tag: mount_tags::SHARED.to_string(),
            read_only: false,
            dax_bytes: DAX_WINDOW_BYTES,
        }];
        shares.extend(
            options
                .volumes
                .iter()
                .enumerate()
                .map(|(i, volume)| ShareLayout {
                    tag: volume_tag(i),
                    read_only: volume.read_only,
                    dax_bytes: DAX_WINDOW_BYTES,
                }),
        );
        let mut found = self.shares.clone();
        found.sort_by(|a, b| a.tag.cmp(&b.tag));
        shares.sort_by(|a, b| a.tag.cmp(&b.tag));
        if found != shares || self.vm_owned_shares != 1 {
            return Err(invalid(format_args!(
                "the image's shares {:?} (+{} VM-owned) are not the box's {shares:?} (+1)",
                self.shares, self.vm_owned_shares
            )));
        }
        let network = matches!(options.network, NetworkSpec::Enabled { .. });
        let expected_nic = network.then_some(crate::net::constants::GUEST_MAC);
        if self.nic_mac != expected_nic {
            return Err(invalid(format_args!(
                "the image's NIC {:?} does not match the box's network ({expected_nic:?})",
                self.nic_mac
            )));
        }
        let ports = [
            VsockPort {
                port: GUEST_AGENT_PORT,
                listen: true,
            },
            VsockPort {
                port: GUEST_READY_PORT,
                listen: false,
            },
        ];
        if self.vsock_ports != ports {
            return Err(invalid(format_args!(
                "the image's vsock ports {:?} are not the guest agent's",
                self.vsock_ports
            )));
        }
        Ok(())
    }
}

// ── KRUNVM image metadata ───────────────────────────────────────────────

/// The parts of libkrun's image metadata the host checks; everything else
/// is libkrun's to validate.
#[derive(Deserialize)]
struct KrunMetadata {
    cpus: Vec<serde::de::IgnoredAny>,
    regions: Vec<KrunRegion>,
    disks: Vec<KrunDisk>,
    nic: Option<KrunNic>,
    vsock: Option<KrunVsock>,
    fs: Option<KrunFs>,
}

#[derive(Deserialize)]
struct KrunRegion {
    len: u64,
}

#[derive(Deserialize)]
struct KrunDisk {
    read_only: bool,
    disk_bytes: u64,
}

#[derive(Deserialize)]
struct KrunNic {
    mac: [u8; 6],
}

#[derive(Deserialize)]
struct KrunVsock {
    ports: Vec<VsockPort>,
}

#[derive(Deserialize)]
struct KrunFs {
    devices: Vec<KrunShare>,
}

#[derive(Deserialize)]
struct KrunShare {
    tag: String,
    read_only: bool,
    vm_owned: bool,
    dax: Option<KrunDax>,
}

#[derive(Deserialize)]
struct KrunDax {
    len: u64,
}

fn checked_sum(mut values: impl Iterator<Item = u64>) -> Option<u64> {
    values.try_fold(0u64, |total, value| total.checked_add(value))
}

/// A KRUNVM image's device layout, plus the length of what follows its RAM
/// and disk segments (the share payloads).
pub(crate) fn read_image_layout(path: &Path) -> BoxliteResult<(DeviceLayout, u64)> {
    let mut file = File::open(path)
        .map_err(|e| invalid(format_args!("open VM image {}: {e}", path.display())))?;
    let mut header = [0u8; KRUNVM_HEADER as usize];
    file.read_exact(&mut header)
        .map_err(|e| invalid(format_args!("VM image header: {e}")))?;
    if &header[..8] != KRUNVM_MAGIC {
        return Err(invalid("the VM image is not a complete KRUNVM image"));
    }
    let version = u32::from_le_bytes(header[8..12].try_into().expect("4 bytes"));
    if version != KRUNVM_VERSION {
        return Err(invalid(format_args!(
            "VM image version {version} (this build reads {KRUNVM_VERSION})"
        )));
    }
    let len = u64::from(u32::from_le_bytes(
        header[12..].try_into().expect("4 bytes"),
    ));
    if len == 0 || len > MAX_KRUNVM_METADATA {
        return Err(invalid("VM image metadata is empty or above 16 MiB"));
    }
    let mut encoded = Vec::new();
    (&mut file)
        .take(len)
        .read_to_end(&mut encoded)
        .map_err(|e| invalid(format_args!("VM image metadata: {e}")))?;
    if encoded.len() as u64 != len {
        return Err(invalid("VM image metadata is truncated"));
    }
    let meta: KrunMetadata = serde_json::from_slice(&encoded)
        .map_err(|e| invalid(format_args!("VM image metadata: {e}")))?;

    let ram_bytes = checked_sum(meta.regions.iter().map(|region| region.len))
        .ok_or_else(|| invalid("VM image RAM length overflows"))?;
    let disk_bytes = checked_sum(meta.disks.iter().map(|disk| disk.disk_bytes))
        .ok_or_else(|| invalid("VM image disk length overflows"))?;
    let fixed = (KRUNVM_HEADER + len)
        .checked_add(ram_bytes)
        .and_then(|total| total.checked_add(disk_bytes))
        .ok_or_else(|| invalid("VM image length overflows"))?;
    let file_len = file
        .metadata()
        .map_err(|e| invalid(format_args!("VM image: {e}")))?
        .len();
    let share_payloads = file_len.checked_sub(fixed).ok_or_else(|| {
        invalid("the VM image is shorter than its metadata, RAM and disk segments")
    })?;

    let devices = meta.fs.map(|fs| fs.devices).unwrap_or_default();
    let layout = DeviceLayout {
        vcpus: meta.cpus.len(),
        ram_bytes,
        disks: meta
            .disks
            .iter()
            .map(|disk| DiskLayout {
                read_only: disk.read_only,
                bytes: disk.disk_bytes,
            })
            .collect(),
        shares: devices
            .iter()
            .filter(|share| !share.vm_owned)
            .map(|share| ShareLayout {
                tag: share.tag.clone(),
                read_only: share.read_only,
                dax_bytes: share.dax.as_ref().map_or(0, |dax| dax.len),
            })
            .collect(),
        vm_owned_shares: devices.iter().filter(|share| share.vm_owned).count(),
        nic_mac: meta.nic.map(|nic| nic.mac),
        vsock_ports: meta.vsock.map(|vsock| vsock.ports).unwrap_or_default(),
    };
    Ok((layout, share_payloads))
}

// ── Hashing ─────────────────────────────────────────────────────────────

/// A reader that hashes and counts what passes through it.
struct Hashing<R> {
    inner: R,
    hasher: Sha256,
    len: u64,
}

impl<R: Read> Hashing<R> {
    fn new(inner: R) -> Self {
        Self {
            inner,
            hasher: Sha256::new(),
            len: 0,
        }
    }

    fn finish(self) -> (u64, String) {
        (
            self.len,
            format!("sha256:{}", hex::encode(self.hasher.finalize())),
        )
    }
}

impl<R: Read> Read for Hashing<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.hasher.update(&buf[..n]);
        self.len += n as u64;
        Ok(n)
    }
}

/// Length and SHA-256 of the file at `path`.
pub(crate) fn digest(path: &Path) -> BoxliteResult<(u64, String)> {
    let file = File::open(path)
        .map_err(|e| BoxliteError::Storage(format!("open {}: {e}", path.display())))?;
    let mut hashing = Hashing::new(file);
    std::io::copy(&mut hashing, &mut std::io::sink())
        .map_err(|e| BoxliteError::Storage(format!("read {}: {e}", path.display())))?;
    Ok(hashing.finish())
}

// ── Write ───────────────────────────────────────────────────────────────

fn member_header(len: u64) -> tar::Header {
    let mut header = tar::Header::new_ustar();
    header.set_entry_type(tar::EntryType::Regular);
    header.set_size(len);
    header.set_mode(0o600);
    header.set_mtime(0);
    header
}

/// Write the checkpoint for `manifest` and the image at `image` into `out`.
/// The image is hashed again on the way, so one that changed after its
/// digest went into the manifest is refused.
pub(crate) fn write(out: &mut File, manifest: &Manifest, image: &Path) -> BoxliteResult<()> {
    let storage = |what: &str, e: std::io::Error| {
        BoxliteError::Storage(format!("write checkpoint {what}: {e}"))
    };
    let encoded = serde_json::to_vec_pretty(manifest)
        .map_err(|e| BoxliteError::Internal(format!("encode checkpoint manifest: {e}")))?;
    let mut builder = tar::Builder::new(&mut *out);
    builder
        .append_data(
            &mut member_header(encoded.len() as u64),
            MANIFEST_MEMBER,
            encoded.as_slice(),
        )
        .map_err(|e| storage("manifest", e))?;
    let file = File::open(image).map_err(|e| storage("image", e))?;
    let mut hashing = Hashing::new(file.take(manifest.image.length));
    builder
        .append_data(
            &mut member_header(manifest.image.length),
            IMAGE_MEMBER,
            &mut hashing,
        )
        .map_err(|e| storage("image", e))?;
    if hashing.finish() != (manifest.image.length, manifest.image.sha256.clone()) {
        return Err(BoxliteError::Storage(
            "the VM image changed while the checkpoint was written".into(),
        ));
    }
    builder.finish().map_err(|e| storage("end", e))?;
    drop(builder);
    out.flush().map_err(|e| storage("flush", e))
}

// ── Read ────────────────────────────────────────────────────────────────

/// A member of a checkpoint archive, checked to be the expected regular file.
fn expect_member<'a, R: Read>(
    entry: Option<std::io::Result<tar::Entry<'a, R>>>,
    name: &str,
) -> BoxliteResult<tar::Entry<'a, R>> {
    let entry = entry
        .ok_or_else(|| invalid(format_args!("member {name} is missing")))?
        .map_err(|e| invalid(format_args!("member {name}: {e}")))?;
    let path = entry
        .path()
        .map_err(|e| invalid(format_args!("member name: {e}")))?
        .into_owned();
    if path != Path::new(name) {
        return Err(invalid(format_args!(
            "expected member {name}, found {}",
            path.display()
        )));
    }
    if entry.header().entry_type() != tar::EntryType::Regular {
        return Err(invalid(format_args!(
            "member {name} is {:?}, not a regular file",
            entry.header().entry_type()
        )));
    }
    Ok(entry)
}

/// Fail unless `archive` is exactly the two members, each one header block
/// plus its padded contents, and the zero end marker. The tar reader stops at
/// the first zero block, so it would accept appended data or a second archive,
/// and treats a missing end marker as the end.
fn check_framing(archive: &File, manifest_len: u64, image_len: u64) -> BoxliteResult<()> {
    use std::os::unix::fs::FileExt;
    let member = |len: u64| {
        len.checked_next_multiple_of(TAR_BLOCK)
            .and_then(|padded| padded.checked_add(TAR_BLOCK))
    };
    let expected = member(manifest_len)
        .zip(member(image_len))
        .and_then(|(manifest, image)| manifest.checked_add(image)?.checked_add(TAR_END))
        .ok_or_else(|| invalid("the VM image's length overflows"))?;
    let actual = archive
        .metadata()
        .map_err(|e| BoxliteError::Storage(format!("checkpoint: {e}")))?
        .len();
    let mut end = [0u8; TAR_END as usize];
    if actual != expected
        || archive.read_exact_at(&mut end, expected - TAR_END).is_err()
        || end.iter().any(|&byte| byte != 0)
    {
        return Err(invalid(format_args!(
            "the archive is {actual} bytes; it must end right after the VM image with the tar \
             end marker ({expected} bytes)"
        )));
    }
    Ok(())
}

/// Read and verify the checkpoint at `archive`, writing its VM image to
/// `image` (a new 0600 file). Returns the manifest and the image's share
/// payload length once every check passed; on failure `image` may hold a
/// partial copy, which the caller removes with its staging directory.
pub(crate) fn read(archive: &Path, image: &Path) -> BoxliteResult<(Manifest, u64)> {
    let file = File::open(archive)
        .map_err(|e| BoxliteError::NotFound(format!("checkpoint {}: {e}", archive.display())))?;
    let framing = file
        .try_clone()
        .map_err(|e| BoxliteError::Storage(format!("checkpoint {}: {e}", archive.display())))?;
    let mut tar = tar::Archive::new(file);
    let mut entries = tar
        .entries()
        .map_err(|e| invalid(format_args!("not a checkpoint archive: {e}")))?;

    let entry = expect_member(entries.next(), MANIFEST_MEMBER)?;
    let size = entry.header().size().map_err(invalid)?;
    if size > MAX_MANIFEST_BYTES {
        return Err(invalid("the manifest is larger than 1 MiB"));
    }
    let mut encoded = Vec::new();
    entry
        .take(size)
        .read_to_end(&mut encoded)
        .map_err(|e| invalid(format_args!("manifest: {e}")))?;
    let manifest: Manifest =
        serde_json::from_slice(&encoded).map_err(|e| invalid(format_args!("manifest: {e}")))?;
    if manifest.format != FORMAT {
        return Err(invalid(format_args!("format {:?}", manifest.format)));
    }
    if manifest.version != VERSION {
        return Err(invalid(format_args!(
            "manifest version {} (this build reads {VERSION})",
            manifest.version
        )));
    }
    if manifest.image.krunvm_version != KRUNVM_VERSION {
        return Err(invalid(format_args!(
            "VM image version {} (this build reads {KRUNVM_VERSION})",
            manifest.image.krunvm_version
        )));
    }

    let entry = expect_member(entries.next(), IMAGE_MEMBER)?;
    if entry.header().size().map_err(invalid)? != manifest.image.length {
        return Err(invalid("the VM image's length differs from the manifest"));
    }
    check_framing(&framing, size, manifest.image.length)?;
    let mut out = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(image)
        .map_err(|e| BoxliteError::Storage(format!("stage {}: {e}", image.display())))?;
    let mut hashing = Hashing::new(entry);
    std::io::copy(&mut hashing, &mut out).map_err(|e| invalid(format_args!("VM image: {e}")))?;
    out.sync_all()
        .map_err(|e| BoxliteError::Storage(format!("sync {}: {e}", image.display())))?;
    if hashing.finish() != (manifest.image.length, manifest.image.sha256.clone()) {
        return Err(invalid(
            "the VM image's SHA-256 or length differs from the manifest",
        ));
    }
    if let Some(extra) = entries.next() {
        let name = extra
            .ok()
            .and_then(|entry| entry.path().ok().map(|path| path.display().to_string()))
            .unwrap_or_else(|| "<unreadable>".into());
        return Err(invalid(format_args!("unexpected member {name}")));
    }

    let (layout, share_payloads) = read_image_layout(image)?;
    if layout != manifest.layout {
        return Err(invalid(format_args!(
            "the VM image's devices {layout:?} differ from the manifest's {:?}",
            manifest.layout
        )));
    }
    Ok((manifest, share_payloads))
}

#[cfg(test)]
pub(crate) mod tests;
