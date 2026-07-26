//! Task: Boot assets - prepare box-scoped custom kernel files.

use std::path::{Path, PathBuf};

use async_trait::async_trait;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use serde::{Deserialize, Serialize};

use super::{InitCtx, log_task_error, task_start};
use crate::litebox::archive::sha256_file;
use crate::litebox::init::types::PreparedBootAssets;
use crate::pipeline::PipelineTask;
use crate::runtime::layout::BoxFilesystemLayout;
use crate::runtime::options::{KernelFormat, KernelOptions};
use crate::vmm::PreparedKernel;

const MANIFEST_VERSION: u32 = 1;
const MANIFEST_FILE: &str = "current.json";
const GENERATIONS_DIR: &str = "generations";
const LEGACY_KERNEL_FILE: &str = "kernel";
const LEGACY_INITRAMFS_FILE: &str = "initramfs";

pub struct BootAssetsTask;

#[async_trait]
impl PipelineTask<InitCtx> for BootAssetsTask {
    async fn run(self: Box<Self>, ctx: InitCtx) -> BoxliteResult<()> {
        let task_name = self.name();
        let box_id = task_start(&ctx, task_name).await;
        let (layout, configured) = {
            let ctx = ctx.lock().await;
            let layout = ctx
                .layout
                .clone()
                .ok_or_else(|| BoxliteError::Internal("filesystem task must run first".into()))?;
            (layout, ctx.config.options.advanced.kernel.clone())
        };

        let kernel = match configured {
            None => None,
            Some(configured) => Some(
                tokio::task::spawn_blocking(move || {
                    let store = BootAssetStore::new(layout);
                    store.prepare(&configured)
                })
                .await
                .map_err(|error| {
                    BoxliteError::Internal(format!("boot assets task panicked: {error}"))
                })?
                .inspect_err(|error| log_task_error(&box_id, task_name, error))?,
            ),
        };

        ctx.lock().await.boot_assets = Some(PreparedBootAssets { kernel });
        Ok(())
    }

    fn name(&self) -> &str {
        "boot_assets_prepare"
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct BootAssetsManifest {
    version: u32,
    generation: String,
    format: KernelFormat,
    kernel_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    initramfs_sha256: Option<String>,
}

struct BootAssetStore {
    layout: BoxFilesystemLayout,
}

impl BootAssetStore {
    fn new(layout: BoxFilesystemLayout) -> Self {
        Self { layout }
    }

    fn stage(&self, configured: &KernelOptions) -> BoxliteResult<PreparedKernel> {
        configured.sanitize()?;
        self.publish_generation(configured)
    }

    fn prepare(&self, configured: &KernelOptions) -> BoxliteResult<PreparedKernel> {
        if let Some(prepared) = self.load_current(configured)? {
            return Ok(prepared);
        }

        if let Some(legacy) = self.legacy_configuration(configured) {
            tracing::info!(
                boot_dir = %self.layout.boot_dir().display(),
                "Migrating legacy custom boot assets"
            );
            return self.stage(&legacy);
        }

        self.stage(configured)
    }

    fn load_current(&self, configured: &KernelOptions) -> BoxliteResult<Option<PreparedKernel>> {
        let manifest_path = self.layout.boot_dir().join(MANIFEST_FILE);
        let manifest_bytes = match std::fs::read(&manifest_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(BoxliteError::Storage(format!(
                    "failed to read boot assets manifest {}: {error}",
                    manifest_path.display()
                )));
            }
        };
        let manifest: BootAssetsManifest =
            serde_json::from_slice(&manifest_bytes).map_err(|error| {
                BoxliteError::Storage(format!(
                    "invalid boot assets manifest {}: {error}",
                    manifest_path.display()
                ))
            })?;

        if manifest.version != MANIFEST_VERSION {
            return Err(BoxliteError::Storage(format!(
                "unsupported boot assets manifest version {} at {}",
                manifest.version,
                manifest_path.display()
            )));
        }
        validate_generation_name(&manifest.generation)?;
        if manifest.format == KernelFormat::Auto {
            return Err(BoxliteError::Storage(format!(
                "boot assets manifest has unresolved kernel format at {}",
                manifest_path.display()
            )));
        }
        if configured.format != KernelFormat::Auto && configured.format != manifest.format {
            return Err(BoxliteError::InvalidState(format!(
                "staged kernel format '{}' does not match configured format '{}'",
                manifest.format.as_str(),
                configured.format.as_str()
            )));
        }

        let expects_initramfs = configured.initramfs.is_some();
        if expects_initramfs != manifest.initramfs_sha256.is_some() {
            return Err(BoxliteError::InvalidState(
                "staged initramfs does not match the persisted kernel configuration".to_string(),
            ));
        }

        let generation_dir = self
            .layout
            .boot_dir()
            .join(GENERATIONS_DIR)
            .join(&manifest.generation);
        let kernel_path = generation_dir.join(LEGACY_KERNEL_FILE);
        verify_checksum("kernel", &kernel_path, &manifest.kernel_sha256)?;
        let initramfs_path = manifest
            .initramfs_sha256
            .as_deref()
            .map(|expected| {
                let path = generation_dir.join(LEGACY_INITRAMFS_FILE);
                verify_checksum("initramfs", &path, expected)?;
                Ok::<PathBuf, BoxliteError>(path)
            })
            .transpose()?;

        PreparedKernel::new(
            kernel_path,
            manifest.format,
            initramfs_path,
            configured.command_line.clone(),
        )
        .map(Some)
    }

    fn legacy_configuration(&self, configured: &KernelOptions) -> Option<KernelOptions> {
        let boot_dir = self.layout.boot_dir();
        let kernel = boot_dir.join(LEGACY_KERNEL_FILE);
        if !kernel.is_file() {
            return None;
        }

        let initramfs = match configured.initramfs {
            Some(_) => {
                let path = boot_dir.join(LEGACY_INITRAMFS_FILE);
                if !path.is_file() {
                    return None;
                }
                Some(path)
            }
            None => None,
        };
        Some(KernelOptions {
            path: kernel,
            format: configured.format,
            initramfs,
            command_line: configured.command_line.clone(),
        })
    }

    fn publish_generation(&self, configured: &KernelOptions) -> BoxliteResult<PreparedKernel> {
        let kernel_source = canonical_source(&configured.path, "kernel")?;
        let initramfs_source = configured
            .initramfs
            .as_deref()
            .map(|path| canonical_source(path, "initramfs"))
            .transpose()?;
        let format = configured.resolve_format()?;
        let boot_dir = self.layout.boot_dir();
        let generations_dir = boot_dir.join(GENERATIONS_DIR);
        std::fs::create_dir_all(&generations_dir).map_err(|error| {
            BoxliteError::Storage(format!(
                "failed to create boot assets directory {}: {error}",
                generations_dir.display()
            ))
        })?;

        let generation = nanoid::nanoid!(12);
        let staging_dir = boot_dir.join(format!(".staging-{generation}"));
        let generation_dir = generations_dir.join(&generation);
        let manifest_staging = boot_dir.join(format!(".{MANIFEST_FILE}-{generation}.staging"));

        let mut generation_was_published = false;
        let result = (|| {
            std::fs::create_dir(&staging_dir).map_err(|error| {
                BoxliteError::Storage(format!(
                    "failed to create boot assets staging directory {}: {error}",
                    staging_dir.display()
                ))
            })?;

            let staged_kernel = staging_dir.join(LEGACY_KERNEL_FILE);
            copy_asset(&kernel_source, &staged_kernel, "kernel")?;
            let kernel_sha256 = sha256_file(&staged_kernel)?;
            let initramfs_sha256 = initramfs_source
                .as_deref()
                .map(|source| {
                    let destination = staging_dir.join(LEGACY_INITRAMFS_FILE);
                    copy_asset(source, &destination, "initramfs")?;
                    sha256_file(&destination)
                })
                .transpose()?;

            std::fs::rename(&staging_dir, &generation_dir).map_err(|error| {
                BoxliteError::Storage(format!(
                    "failed to publish boot assets generation {}: {error}",
                    generation_dir.display()
                ))
            })?;
            generation_was_published = true;

            let prepared = PreparedKernel::new(
                generation_dir.join(LEGACY_KERNEL_FILE),
                format,
                initramfs_source
                    .as_ref()
                    .map(|_| generation_dir.join(LEGACY_INITRAMFS_FILE)),
                configured.command_line.clone(),
            )?;
            let manifest = BootAssetsManifest {
                version: MANIFEST_VERSION,
                generation: generation.clone(),
                format,
                kernel_sha256,
                initramfs_sha256,
            };
            write_manifest(&manifest_staging, &manifest)?;
            std::fs::rename(&manifest_staging, boot_dir.join(MANIFEST_FILE)).map_err(|error| {
                BoxliteError::Storage(format!(
                    "failed to publish boot assets manifest in {}: {error}",
                    boot_dir.display()
                ))
            })?;

            tracing::info!(
                kernel_source = %kernel_source.display(),
                initramfs_source = ?initramfs_source,
                generation,
                "Prepared custom boot assets"
            );
            Ok(prepared)
        })();

        if result.is_err() {
            let _ = std::fs::remove_dir_all(&staging_dir);
            if generation_was_published {
                let _ = std::fs::remove_dir_all(&generation_dir);
            }
            let _ = std::fs::remove_file(&manifest_staging);
        }
        result
    }
}

fn canonical_source(source: &Path, label: &str) -> BoxliteResult<PathBuf> {
    source.canonicalize().map_err(|error| {
        BoxliteError::Config(format!(
            "failed to resolve custom {label} {}: {error}",
            source.display()
        ))
    })
}

fn copy_asset(source: &Path, destination: &Path, label: &str) -> BoxliteResult<()> {
    std::fs::copy(source, destination).map_err(|error| {
        BoxliteError::Storage(format!(
            "failed to stage custom {label} {} at {}: {error}",
            source.display(),
            destination.display()
        ))
    })?;
    Ok(())
}

fn write_manifest(path: &Path, manifest: &BootAssetsManifest) -> BoxliteResult<()> {
    use std::io::Write;

    let bytes = serde_json::to_vec_pretty(manifest).map_err(|error| {
        BoxliteError::Internal(format!("failed to serialize boot assets manifest: {error}"))
    })?;
    let mut file = std::fs::File::create(path).map_err(|error| {
        BoxliteError::Storage(format!(
            "failed to create boot assets manifest {}: {error}",
            path.display()
        ))
    })?;
    file.write_all(&bytes).map_err(|error| {
        BoxliteError::Storage(format!(
            "failed to write boot assets manifest {}: {error}",
            path.display()
        ))
    })?;
    file.sync_all().map_err(|error| {
        BoxliteError::Storage(format!(
            "failed to sync boot assets manifest {}: {error}",
            path.display()
        ))
    })
}

fn verify_checksum(label: &str, path: &Path, expected: &str) -> BoxliteResult<()> {
    let actual = sha256_file(path)?;
    if actual != expected {
        return Err(BoxliteError::Storage(format!(
            "staged custom {label} checksum mismatch at {}: expected {expected}, got {actual}",
            path.display()
        )));
    }
    Ok(())
}

fn validate_generation_name(generation: &str) -> BoxliteResult<()> {
    if generation.is_empty()
        || generation.len() > 64
        || !generation
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(BoxliteError::Storage(format!(
            "invalid boot assets generation name: {generation:?}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::layout::FsLayoutConfig;

    fn valid_format() -> KernelFormat {
        #[cfg(target_arch = "x86_64")]
        return KernelFormat::Elf;
        #[cfg(target_arch = "aarch64")]
        return KernelFormat::PeGz;
        #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
        return KernelFormat::Raw;
    }

    fn fixture() -> (
        tempfile::TempDir,
        BoxFilesystemLayout,
        KernelOptions,
        PathBuf,
        PathBuf,
    ) {
        let temp = tempfile::tempdir().unwrap();
        let layout = BoxFilesystemLayout::new(
            temp.path().join("box"),
            FsLayoutConfig::without_bind_mount(),
            false,
        );
        let kernel = temp.path().join("vmlinux");
        let initramfs = temp.path().join("initramfs.img");
        std::fs::write(&kernel, b"kernel bytes").unwrap();
        std::fs::write(&initramfs, b"initramfs bytes").unwrap();
        let configured = KernelOptions::new(&kernel)
            .with_format(valid_format())
            .with_initramfs(&initramfs)
            .with_command_line("console=ttyS0");
        (temp, layout, configured, kernel, initramfs)
    }

    #[test]
    fn stage_publishes_complete_generation() {
        let (_temp, layout, configured, kernel, initramfs) = fixture();
        let prepared = BootAssetStore::new(layout.clone())
            .stage(&configured)
            .unwrap();

        assert!(layout.boot_dir().join(MANIFEST_FILE).is_file());
        assert!(
            prepared
                .path
                .starts_with(layout.boot_dir().join(GENERATIONS_DIR))
        );
        assert_eq!(
            std::fs::read(&prepared.path).unwrap(),
            std::fs::read(kernel).unwrap()
        );
        assert_eq!(
            std::fs::read(prepared.initramfs.as_ref().unwrap()).unwrap(),
            std::fs::read(initramfs).unwrap()
        );
        assert_eq!(prepared.format, valid_format());
        assert_eq!(prepared.command_line.as_deref(), Some("console=ttyS0"));
    }

    #[test]
    fn restart_reuses_generation_after_sources_are_removed() {
        let (_temp, layout, configured, kernel, initramfs) = fixture();
        let store = BootAssetStore::new(layout);
        let staged = store.stage(&configured).unwrap();
        std::fs::remove_file(kernel).unwrap();
        std::fs::remove_file(initramfs).unwrap();

        let reused = store.prepare(&configured).unwrap();

        assert_eq!(reused, staged);
    }

    #[test]
    fn restart_rejects_corrupt_staged_kernel_without_falling_back() {
        let (_temp, layout, configured, _kernel, _initramfs) = fixture();
        let store = BootAssetStore::new(layout);
        let staged = store.stage(&configured).unwrap();
        std::fs::write(staged.path, b"tampered").unwrap();

        let error = store.prepare(&configured).unwrap_err();

        assert!(error.to_string().contains("checksum mismatch"), "{error}");
    }

    #[test]
    fn restart_migrates_legacy_assets_without_original_sources() {
        let (temp, layout, configured, kernel, initramfs) = fixture();
        std::fs::create_dir_all(layout.boot_dir()).unwrap();
        std::fs::copy(&kernel, layout.boot_dir().join(LEGACY_KERNEL_FILE)).unwrap();
        std::fs::copy(&initramfs, layout.boot_dir().join(LEGACY_INITRAMFS_FILE)).unwrap();
        std::fs::remove_file(kernel).unwrap();
        std::fs::remove_file(initramfs).unwrap();
        assert!(temp.path().exists());

        let prepared = BootAssetStore::new(layout.clone())
            .prepare(&configured)
            .unwrap();

        assert!(layout.boot_dir().join(MANIFEST_FILE).is_file());
        assert!(
            prepared
                .path
                .starts_with(layout.boot_dir().join(GENERATIONS_DIR))
        );
    }

    #[test]
    fn generation_name_rejects_path_traversal() {
        assert!(validate_generation_name("../outside").is_err());
        assert!(validate_generation_name("valid_123-name").is_ok());
    }
}
