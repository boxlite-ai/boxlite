//! Adapt a captured archive without modifying the native import contract.

use std::collections::BTreeMap;

use crate::runtime::rt_impl::SharedRuntimeImpl;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::litebox::archive::{
    ArchiveManifest, MANIFEST_FILENAME, build_zstd_tar_archive, extract_archive, sha256_file,
};
use crate::runtime::options::{ArchiveImportPolicy, BoxOptions, RootfsSpec};
use crate::{BoxliteError, BoxliteResult};

/// Immutable archive identity supplied by checkpoint storage after download.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CheckpointArchiveSource {
    pub path: PathBuf,
    /// Lowercase SHA-256 hex, optionally prefixed with `sha256:`.
    pub sha256: String,
    pub pinned_image: String,
}

pub struct PreparedCheckpointArchive {
    path: PathBuf,
    pinned_image: String,
    options: BoxOptions,
    size_bytes: u64,
    sha256: String,
    _directory: tempfile::TempDir,
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

fn pinned_image(image: &str) -> BoxliteResult<String> {
    let digest = image
        .split_once('@')
        .map(|(_, digest)| digest)
        .ok_or_else(|| {
            BoxliteError::InvalidArgument("checkpoint startup image must be digest-pinned".into())
        })?;
    let suffix = digest
        .strip_prefix("sha256:")
        .filter(|suffix| suffix.len() == 64 && suffix.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .ok_or_else(|| {
            BoxliteError::InvalidArgument(
                "checkpoint image requires a SHA-256 manifest digest".into(),
            )
        })?;
    let reference = image.split_once('@').map_or(image, |(name, _)| name);
    let repository = match reference.rsplit_once(':') {
        Some((name, tag)) if !tag.contains('/') => name,
        _ => reference,
    };
    Ok(format!(
        "{repository}@sha256:{}",
        suffix.to_ascii_lowercase()
    ))
}

fn require_supported_options(options: &BoxOptions) -> BoxliteResult<()> {
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

fn prepare_source(
    source: &CheckpointArchiveSource,
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
    source: &CheckpointArchiveSource,
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
        super::import::options_from_manifest(&manifest, ArchiveImportPolicy::Trusted)?;
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
    let pinned = pinned_image(&source.pinned_image)?;
    let disk = directory
        .path()
        .join(crate::disk::constants::filenames::CONTAINER_DISK);
    super::import::validate_no_backing_references(&disk)?;
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
    let options = super::import::options_from_manifest(&derived, ArchiveImportPolicy::Trusted)?;
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

/// Validate downloaded cloud bytes before the runner replaces its native box.
pub(crate) async fn prepare(
    runtime: SharedRuntimeImpl,
    source: CheckpointArchiveSource,
    platform_env: Option<BTreeMap<String, String>>,
) -> BoxliteResult<PreparedCheckpointArchive> {
    if runtime.shutdown_token.is_cancelled() {
        return Err(BoxliteError::Stopped(
            "Cannot prepare archive: runtime has been shut down".into(),
        ));
    }
    // Accepted native work retains its staging even if its caller stops waiting.
    tokio::spawn(async move {
        let directory = runtime.layout.temp_dir();
        let prepared =
            tokio::task::spawn_blocking(move || prepare_source(&source, platform_env, &directory))
                .await
                .map_err(task_error)??;
        runtime
            .experimental_features
            .require_for_options(&prepared.options)?;
        runtime
            .image_manager
            .pull(&prepared.pinned_image)
            .await?
            .load_config()
            .await?;
        Ok(prepared)
    })
    .await
    .map_err(task_error)?
}

fn task_error(error: tokio::task::JoinError) -> BoxliteError {
    BoxliteError::Internal(format!("checkpoint archive preparation failed: {error}"))
}

#[cfg(test)]
mod tests;
