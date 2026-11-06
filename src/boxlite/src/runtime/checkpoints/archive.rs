//! Adapt a captured archive without modifying the native import contract.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use super::catalog::Lease;
use crate::litebox::archive::{
    ArchiveManifest, MANIFEST_FILENAME, build_zstd_tar_archive, extract_archive, sha256_file,
};
use crate::runtime::options::{ArchiveImportPolicy, BoxOptions, RootfsSpec};
use crate::{BoxliteError, BoxliteResult, ResolvedImage};

pub struct PreparedCheckpointArchive {
    pub(super) path: PathBuf,
    pub(super) pinned_image: String,
    pub(super) options: BoxOptions,
    size_bytes: u64,
    sha256: String,
    _directory: tempfile::TempDir,
    // The source archive cannot be deleted while extraction/import uses it.
    _lease: Option<Lease>,
}

impl PreparedCheckpointArchive {
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn pinned_image(&self) -> &str {
        &self.pinned_image
    }
    pub fn size_bytes(&self) -> u64 {
        self.size_bytes
    }
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
}

pub(super) fn pinned_image(
    options: &BoxOptions,
    resolved: Option<&ResolvedImage>,
) -> BoxliteResult<String> {
    require_supported_options(options)?;
    let RootfsSpec::Image(image) = &options.rootfs else {
        return Err(BoxliteError::Unsupported(
            "checkpoints require an OCI image; host rootfs paths are external dependencies".into(),
        ));
    };
    let digest = resolved.map(|image| image.manifest_digest.as_str())
        .or_else(|| image.split_once('@').map(|(_, digest)| digest))
        .ok_or_else(|| BoxliteError::InvalidState("the source box has no recorded image build; a mutable tag cannot identify the disk's original startup configuration".into()))?;
    let suffix = digest
        .strip_prefix("sha256:")
        .filter(|suffix| suffix.len() == 64 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| {
            BoxliteError::InvalidArgument(
                "checkpoint image requires a SHA-256 manifest digest".into(),
            )
        })?;
    let reference = image
        .split_once('@')
        .map_or(image.as_str(), |(name, _)| name);
    let repository = match reference.rsplit_once(':') {
        Some((name, tag)) if !tag.contains('/') => name,
        _ => reference,
    };
    Ok(format!(
        "{repository}@sha256:{}",
        suffix.to_ascii_lowercase()
    ))
}

pub(super) fn require_supported_options(options: &BoxOptions) -> BoxliteResult<()> {
    if !matches!(options.rootfs, RootfsSpec::Image(_)) {
        return Err(BoxliteError::Unsupported(
            "checkpoints require an OCI image; host rootfs paths are external dependencies".into(),
        ));
    }
    if !options.volumes.is_empty() || !options.mounts.is_empty() || !options.secrets.is_empty() {
        return Err(BoxliteError::Unsupported(
            "checkpoints with volumes, mounts or secrets are not supported".into(),
        ));
    }
    Ok(())
}

pub(super) fn prepare(lease: Lease, work_dir: &Path) -> BoxliteResult<PreparedCheckpointArchive> {
    lease.verify()?;
    let mut prepared = prepare_verified_source(
        &super::CheckpointArchiveSource {
            path: lease.archive.clone(),
            sha256: lease.record.archive_sha256.clone(),
            pinned_image: lease.record.pinned_image.clone(),
        },
        None,
        work_dir,
    )?;
    prepared._lease = Some(lease);
    Ok(prepared)
}

pub(super) fn prepare_source(
    source: &super::CheckpointArchiveSource,
    platform_env: Option<BTreeMap<String, String>>,
    work_dir: &Path,
) -> BoxliteResult<PreparedCheckpointArchive> {
    let digest = source
        .sha256
        .strip_prefix("sha256:")
        .unwrap_or(&source.sha256);
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(BoxliteError::InvalidArgument(
            "checkpoint requires a lowercase SHA-256 archive digest".into(),
        ));
    }
    if sha256_file(&source.path)?.strip_prefix("sha256:") != Some(digest) {
        return Err(BoxliteError::Storage(
            "checkpoint archive checksum does not match its record".into(),
        ));
    }
    prepare_verified_source(source, platform_env, work_dir)
}

fn prepare_verified_source(
    source: &super::CheckpointArchiveSource,
    platform_env: Option<BTreeMap<String, String>>,
    work_dir: &Path,
) -> BoxliteResult<PreparedCheckpointArchive> {
    if let Some(env) = &platform_env
        && (env.get("BOXLITE_BOX_ID").is_none_or(String::is_empty)
            || env.iter().any(|(key, value)| {
                !PLATFORM_ENV_KEYS.contains(&key.as_str()) || value.contains('\0')
            }))
    {
        return Err(BoxliteError::InvalidArgument("checkpoint platform environment requires a target box ID and only reserved identity keys".into()));
    }
    let directory = tempfile::tempdir_in(work_dir)?;
    extract_archive(&source.path, directory.path())?;
    let manifest_path = directory.path().join(MANIFEST_FILENAME);
    let original = std::fs::read(&manifest_path)?;
    let manifest: ArchiveManifest = serde_json::from_slice(&original)
        .map_err(|error| BoxliteError::Storage(format!("invalid checkpoint manifest: {error}")))?;
    if !(3..=crate::litebox::archive::MAX_SUPPORTED_VERSION).contains(&manifest.version)
        || manifest.box_options.is_none()
    {
        return Err(BoxliteError::Unsupported(
            "checkpoint requires a supported archive with complete box_options".into(),
        ));
    }
    let mut options =
        super::super::import::options_from_manifest(&manifest, ArchiveImportPolicy::Trusted)?;
    require_supported_options(&options)?;
    // Native import validates persisted kernel options without reopening source
    // files. A replacement must discover unavailable boot dependencies before
    // removing its predecessor; the archive does not bundle these assets.
    if let Some(kernel) = &options.advanced.kernel {
        kernel.sanitize()?;
        for path in std::iter::once(&kernel.path).chain(kernel.initramfs.iter()) {
            let asset = std::fs::File::open(path).map_err(|error| {
                BoxliteError::Config(format!(
                    "checkpoint boot asset {} is not readable: {error}",
                    path.display()
                ))
            })?;
            if !asset.metadata()?.is_file() {
                return Err(BoxliteError::Config(format!(
                    "checkpoint boot asset {} must be a regular file",
                    path.display()
                )));
            }
        }
    }
    let pinned = pinned_image(
        &BoxOptions {
            rootfs: RootfsSpec::Image(source.pinned_image.clone()),
            ..Default::default()
        },
        None,
    )?;
    let disk = directory
        .path()
        .join(crate::disk::constants::filenames::CONTAINER_DISK);
    super::super::import::validate_no_backing_references(&disk)?;
    if manifest.container_disk_checksum.is_empty()
        || sha256_file(&disk)? != manifest.container_disk_checksum
    {
        return Err(BoxliteError::Storage(
            "checkpoint disk checksum mismatch".into(),
        ));
    }

    // Preserve unknown compatible fields and disk bytes. Only the image
    // locator and explicitly requested platform identity are rebound.
    let mut json: serde_json::Value = serde_json::from_slice(&original)
        .map_err(|error| BoxliteError::Storage(format!("invalid checkpoint manifest: {error}")))?;
    json["image"] = pinned.clone().into();
    json["box_options"]["rootfs"] = serde_json::json!({"Image": pinned});
    if let Some(env) = platform_env {
        options
            .env
            .retain(|(key, _)| !PLATFORM_ENV_KEYS.contains(&key.as_str()));
        options.env.extend(env);
        json["box_options"]["env"] = serde_json::to_value(options.env)
            .map_err(|error| BoxliteError::Storage(error.to_string()))?;
    }
    let derived: ArchiveManifest = serde_json::from_value(json.clone())
        .map_err(|error| BoxliteError::Storage(error.to_string()))?;
    let options =
        super::super::import::options_from_manifest(&derived, ArchiveImportPolicy::Trusted)?;
    std::fs::write(
        &manifest_path,
        serde_json::to_vec(&json).map_err(|error| {
            BoxliteError::Storage(format!("cannot serialize checkpoint manifest: {error}"))
        })?,
    )?;
    let path = directory.path().join("import.boxlite");
    build_zstd_tar_archive(&path, &manifest_path, &disk, 1)?;
    let size_bytes = std::fs::metadata(&path)?.len();
    let checksum = sha256_file(&path)?;
    let sha256 = checksum
        .strip_prefix("sha256:")
        .unwrap_or(&checksum)
        .to_owned();
    Ok(PreparedCheckpointArchive {
        path,
        pinned_image: pinned,
        options,
        size_bytes,
        sha256,
        _directory: directory,
        _lease: None,
    })
}

const PLATFORM_ENV_KEYS: [&str; 6] = [
    "BOXLITE_BOX_ID",
    "BOXLITE_OTEL_ENDPOINT",
    "BOXLITE_ORGANIZATION_ID",
    "BOXLITE_REGION_ID",
    "BOXLITE_TRACEPARENT",
    "BOXLITE_TRACESTATE",
];
