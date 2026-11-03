//! Runner-only upload admission. Saved host paths and isolation are never trusted.

use super::{Catalog, CheckpointInfo};
use crate::litebox::checkpoint::pair::{self, Application, PairFailure, VerifiedPair, invalid};
use crate::runtime::options::{InboundNetworkConfig, NetworkMode, OutboundNetworkConfig};
use crate::runtime::rt_impl::SharedRuntimeImpl;
use crate::{BoxResources, BoxliteError, BoxliteResult, RootfsSpec};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::io::{Seek, SeekFrom};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

/// Allowlisted captured configuration for cloud policy admission, without host paths.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CloudCheckpointConfiguration {
    pub image: String,
    pub env: Vec<(String, String)>,
    pub working_dir: Option<String>,
    pub user: Option<String>,
    pub entrypoint: Option<Vec<String>>,
    pub cmd: Option<Vec<String>>,
    pub tty: bool,
    pub privileged: bool,
    pub outbound: OutboundNetworkConfig,
    pub inbound: InboundNetworkConfig,
}

/// Verified native summary for a server-issued upload transfer identity.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CloudCheckpointInspection {
    /// Admission-summary schema version, independent of the memory file format.
    pub version: u32,
    pub pair_sha256: String,
    pub memory_file_bytes: u64,
    pub qcow2_bytes: u64,
    pub container_disk_bytes: u64,
    pub boot_disk_bytes: u64,
    pub boot_disk_sha256: String,
    pub resources: BoxResources,
    pub configuration: CloudCheckpointConfiguration,
}

/// Runner-only registration inputs. `trusted_boot` is never a public HTTP field.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CloudCheckpointImportOptions {
    pub operation_id: String,
    pub expected_pair_sha256: String,
    pub trusted_boot: Option<PathBuf>,
}

#[derive(Clone, Copy)]
pub(crate) enum Origin {
    Upload,
    Managed,
}
impl Origin {
    fn invalid(self, message: impl std::fmt::Display) -> BoxliteError {
        match self {
            Self::Upload => BoxliteError::InvalidArgument(message.to_string()),
            Self::Managed => invalid(message),
        }
    }
    fn validation(self, error: BoxliteError) -> BoxliteError {
        match self {
            Self::Upload => BoxliteError::InvalidArgument(error.to_string()),
            Self::Managed => error,
        }
    }
}

pub(crate) fn inspect(path: &Path) -> BoxliteResult<CloudCheckpointInspection> {
    let pair = pair::open_checked(path).map_err(PairFailure::cloud)?;
    pair.verify_disk_checked().map_err(PairFailure::cloud)?;
    let (inspection, _) = prepare(&pair, Origin::Upload)?;
    Ok(inspection)
}

fn fingerprint(pair: &VerifiedPair, origin: Origin) -> BoxliteResult<(String, u64)> {
    let memory_length = pair.memory.metadata().map_err(invalid)?.len();
    let disk_length = pair.disk.metadata().map_err(invalid)?.len();
    let map = |error: PairFailure| match origin {
        Origin::Upload => error.cloud(),
        Origin::Managed => error.legacy(),
    };
    let mut hash = Sha256::new();
    hash.update(b"boxlite-cloud-pair-v1\0");
    hash.update(memory_length.to_le_bytes());
    hash.update(pair::digest_checked(&pair.memory, 0, memory_length).map_err(map)?);
    hash.update(disk_length.to_le_bytes());
    hash.update(pair::digest_checked(&pair.disk, 0, disk_length).map_err(map)?);
    Ok((hex::encode(hash.finalize()), memory_length))
}

/// The same validation and normalized policy feed preflight and native execution.
pub(crate) fn prepare(
    pair: &VerifiedPair,
    origin: Origin,
) -> BoxliteResult<(CloudCheckpointInspection, Application)> {
    let mut application: Application =
        serde_json::from_value(pair.dependencies.application.clone())
            .map_err(|_| origin.invalid("invalid checkpoint application configuration"))?;
    pair::validate_resources(application.resources, &pair.dependencies)
        .map_err(|error| origin.validation(error))?;
    if crate::BoxID::parse(&application.source_box_id).is_none()
        || application.guest.boot_id.is_empty()
        || application.guest.init_pid == 0
        || crate::runtime::types::ContainerID::parse(&application.guest.container_id).is_none()
    {
        return Err(origin.invalid("invalid captured guest identity"));
    }
    if application
        .local_paths
        .as_ref()
        .is_none_or(|paths| paths.version != 2)
    {
        return Err(BoxliteError::Unsupported(
            "cloud checkpoints require relocatable local-path metadata v2".into(),
        ));
    }
    let options = &mut application.options;
    if pair.dependencies.network_device
        != matches!(options.network, crate::NetworkSpec::Enabled { .. })
    {
        return Err(origin.invalid("captured network device differs from saved configuration"));
    }
    if !options.volumes.is_empty()
        || !options.mounts.is_empty()
        || !options.ports.is_empty()
        || !options.secrets.is_empty()
        || options.advanced.kernel.is_some()
        || options.advanced.nested_virtualization
        || options.advanced.isolate_mounts
        || options.advanced.health_check.is_some()
        || !options.advanced.network_rate_limit.is_unlimited()
        || options.advanced.capabilities().is_some()
    {
        return Err(BoxliteError::Unsupported(
            "cloud checkpoint contains unsupported mounts, secrets or advanced settings".into(),
        ));
    }
    let image = match &options.rootfs {
        RootfsSpec::Image(image) if !image.is_empty() => image.clone(),
        _ => {
            return Err(BoxliteError::Unsupported(
                "cloud checkpoint requires an image reference, not a host rootfs".into(),
            ));
        }
    };
    let shared_tag = crate::runtime::constants::mount_tags::SHARED;
    if !pair
        .dependencies
        .shares
        .iter()
        .any(|share| !share.vm_owned && share.tag == shared_tag)
    {
        return Err(origin.invalid("captured internal shared filesystem is missing"));
    }
    let layout = boxlite_shared::layout::SharedGuestLayout::new(PathBuf::new());
    let container = layout.container(&application.guest.container_id);
    let mut directories = vec![
        PathBuf::from("."),
        layout.containers_dir(),
        container.root().to_owned(),
        container.overlayfs_dir(),
        container.upper_dir(),
        container.work_dir(),
        container.diff_dir(),
        container.rootfs_dir(),
        container.volumes_dir(),
    ];
    directories.sort();
    for share in &pair.dependencies.shares {
        if share.vm_owned {
            if share.objects.iter().any(|object| {
                object
                    .recipe
                    .as_deref()
                    .is_none_or(|recipe| ![".", "dev", "proc", "sys", "newroot"].contains(&recipe))
            }) {
                return Err(BoxliteError::Unsupported(
                    "cloud checkpoint has a non-reconstructible boot share".into(),
                ));
            }
        } else if share.tag != shared_tag
            || share.objects.iter().any(|object| {
                object.kind != 0o040000
                    || object.reference.as_ref().is_none_or(|reference| {
                        reference.resource_id != "local-path-v2"
                            || !directories.contains(&PathBuf::from(&reference.object_key))
                    })
            })
        {
            return Err(BoxliteError::Unsupported(
                "cloud checkpoint requires an external or non-reconstructible share".into(),
            ));
        }
    }
    let outbound = application
        .outbound_policy
        .clone()
        .unwrap_or_else(|| OutboundNetworkConfig::from(&options.network));
    outbound
        .validate()
        .map_err(|error| origin.validation(error))?;
    let inbound = InboundNetworkConfig::from(&options.inbound_network);
    crate::runtime::options::NetworkSpec::try_from(inbound.clone())
        .map_err(|error| origin.validation(error))?;
    if matches!(options.network, crate::NetworkSpec::Disabled)
        && outbound.mode != NetworkMode::Disabled
    {
        return Err(origin.invalid("captured network device and outbound policy disagree"));
    }
    let configuration = CloudCheckpointConfiguration {
        image,
        env: options.env.clone(),
        working_dir: options.working_dir.clone(),
        user: options.user.clone(),
        entrypoint: options.entrypoint.clone(),
        cmd: options.cmd.clone(),
        tty: options.tty,
        privileged: options.advanced.privileged,
        outbound: outbound.clone(),
        inbound,
    };
    // Keep NIC presence from the captured configuration. Disabled egress on an
    // existing NIC remains an explicit policy, rather than removing that device.
    if let crate::NetworkSpec::Enabled { allow_net } = &mut options.network {
        *allow_net = outbound.allow_net.clone();
    }
    application.outbound_policy = Some(outbound);
    options.advanced.security = crate::SecurityOptions::default();
    options.detach = true;
    options.auto_stop = None;
    options.auto_delete = Some(0);
    options.auto_resume = Some(false);
    #[expect(
        deprecated,
        reason = "clear captured legacy lifecycle control at the runner boundary"
    )]
    {
        options.auto_remove = false;
    }
    options.cpus = Some(application.resources.cpus);
    options.memory_mib = Some(application.resources.memory_mib);
    options
        .sanitize()
        .map_err(|error| origin.validation(error))?;
    let (pair_sha256, memory_file_bytes) = fingerprint(pair, origin)?;
    Ok((
        CloudCheckpointInspection {
            version: 1,
            pair_sha256,
            memory_file_bytes,
            qcow2_bytes: pair.dependencies.qcow2_bytes,
            container_disk_bytes: pair.dependencies.container_disk_bytes,
            boot_disk_bytes: pair.dependencies.boot_disk_bytes,
            boot_disk_sha256: pair.dependencies.boot_disk_sha256.clone(),
            resources: application.resources,
            configuration,
        },
        application,
    ))
}

pub(super) fn register(
    runtime: &SharedRuntimeImpl,
    catalog: &Catalog,
    path: &Path,
    options: CloudCheckpointImportOptions,
) -> BoxliteResult<CheckpointInfo> {
    let operation = uuid::Uuid::parse_str(&options.operation_id).map_err(|_| {
        BoxliteError::InvalidArgument("cloud checkpoint operation must be a canonical UUID".into())
    })?;
    if operation.to_string() != options.operation_id
        || options.expected_pair_sha256.len() != 64
        || !options
            .expected_pair_sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(BoxliteError::InvalidArgument(
            "invalid cloud checkpoint operation or expected pair digest".into(),
        ));
    }
    let _lease = catalog.lease()?;
    let mut pair = pair::open_checked(path).map_err(PairFailure::cloud)?;
    pair.verify_disk_checked().map_err(PairFailure::cloud)?;
    let (inspection, application) = prepare(&pair, Origin::Upload)?;
    if inspection.pair_sha256 != options.expected_pair_sha256 {
        return Err(BoxliteError::InvalidArgument(
            "checkpoint pair differs from preflight".into(),
        ));
    }
    if let Some(existing) = catalog
        .store
        .get(None, &options.operation_id)?
        .filter(|info| info.id == options.operation_id)
    {
        if existing.status != "ready" {
            return Err(BoxliteError::InvalidState(
                "checkpoint operation exists in an incompatible state".into(),
            ));
        }
        let directory = catalog.directory(&existing.id)?;
        let stored = pair::open(&directory.join("pair"))?;
        stored.verify_disk()?;
        let (summary, _) = prepare(&stored, Origin::Managed)?;
        if summary.pair_sha256 != inspection.pair_sha256 {
            return Err(BoxliteError::InvalidState(
                "checkpoint operation already registered different content".into(),
            ));
        }
        verify_boot(&directory.join("boot.raw"), &stored.dependencies)?;
        return Ok(existing);
    }
    let mut boot = if let Some(path) = options.trusted_boot {
        verify_boot(&path, &pair.dependencies)?
    } else {
        let mut boot = None;
        for record in runtime
            .base_disk_mgr
            .store()
            .list_by_box("__global__", Some(crate::disk::BaseDiskKind::Rootfs))?
        {
            let path = PathBuf::from(record.base_path());
            match OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(path)
            {
                Ok(file) if boot_matches(&file, &pair.dependencies)? => {
                    boot = Some(file);
                    break;
                }
                Ok(_) => (),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
                Err(error) => return Err(invalid(error)),
            }
        }
        boot.ok_or_else(|| {
            invalid("exact readonly boot dependency is unavailable in trusted runtime storage")
        })?
    };
    let stage = tempfile::Builder::new()
        .prefix(".archive-")
        .tempdir_in(&catalog.root)
        .map_err(invalid)?;
    std::fs::create_dir(stage.path().join("pair")).map_err(invalid)?;
    for (name, file) in [
        ("pair/snapshot.mem", &mut pair.memory),
        ("pair/snapshot.qcow2", &mut pair.disk),
    ] {
        file.seek(SeekFrom::Start(0)).map_err(invalid)?;
        copy(file, &stage.path().join(name))?;
    }
    copy(&mut boot, &stage.path().join("boot.raw"))?;
    let staged = pair::open_checked(&stage.path().join("pair")).map_err(PairFailure::cloud)?;
    staged.verify_disk_checked().map_err(PairFailure::cloud)?;
    let (copied, _) = prepare(&staged, Origin::Upload)?;
    if copied.pair_sha256 != options.expected_pair_sha256 {
        return Err(BoxliteError::InvalidArgument(
            "checkpoint pair changed during registration".into(),
        ));
    }
    verify_boot(&stage.path().join("boot.raw"), &staged.dependencies)?;
    let info = CheckpointInfo {
        id: options.operation_id.clone(),
        box_id: application.source_box_id,
        name: format!("transfer-{}", options.operation_id),
        created_at: chrono::Utc::now().timestamp(),
        status: "creating".into(),
        error: None,
        cpus: u16::from(inspection.resources.cpus),
        memory_bytes: u64::from(inspection.resources.memory_mib) << 20,
        container_disk_bytes: inspection.container_disk_bytes,
        size_bytes: inspection
            .memory_file_bytes
            .checked_add(inspection.qcow2_bytes)
            .and_then(|size| size.checked_add(inspection.boot_disk_bytes))
            .ok_or_else(|| invalid("managed size overflow"))?,
    };
    catalog.publish_import(stage, info)
}

fn copy(source: &mut File, destination: &Path) -> BoxliteResult<()> {
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(destination)
        .map_err(invalid)?;
    std::io::copy(source, &mut output).map_err(invalid)?;
    output.sync_all().map_err(invalid)
}
fn boot_matches(file: &File, dependencies: &crate::CheckpointDependencies) -> BoxliteResult<bool> {
    Ok(file.metadata().map_err(invalid)?.is_file()
        && file.metadata().map_err(invalid)?.len() == dependencies.boot_disk_bytes
        && hex::encode(pair::digest(file, 0, dependencies.boot_disk_bytes)?)
            == dependencies.boot_disk_sha256)
}
fn verify_boot(path: &Path, dependencies: &crate::CheckpointDependencies) -> BoxliteResult<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(invalid)?;
    if !boot_matches(&file, dependencies)? {
        return Err(invalid("trusted boot dependency length/checksum mismatch"));
    }
    Ok(file)
}

#[cfg(test)]
mod tests;
