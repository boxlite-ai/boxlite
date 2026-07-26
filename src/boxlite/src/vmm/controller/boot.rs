use std::path::{Path, PathBuf};

use crate::runtime::{layout::BoxFilesystemLayout, options::KernelOptions};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

/// Stages direct-boot files behind the box filesystem boundary.
pub(crate) struct BootAssets<'a> {
    layout: &'a BoxFilesystemLayout,
}

impl<'a> BootAssets<'a> {
    pub(crate) fn new(layout: &'a BoxFilesystemLayout) -> Self {
        Self { layout }
    }

    /// Copy a configured kernel and initramfs into the box and return the
    /// equivalent configuration using only box-scoped paths.
    pub(crate) fn stage(
        &self,
        configured: Option<&KernelOptions>,
    ) -> BoxliteResult<Option<KernelOptions>> {
        let Some(configured) = configured else {
            return Ok(None);
        };

        let boot_dir = self.layout.boot_dir();
        std::fs::create_dir_all(&boot_dir).map_err(|error| {
            BoxliteError::Storage(format!(
                "failed to create boot assets directory {}: {error}",
                boot_dir.display()
            ))
        })?;

        let kernel = self.stage_file(&configured.path, &boot_dir.join("kernel"), "kernel")?;
        let initramfs = configured
            .initramfs
            .as_deref()
            .map(|source| self.stage_file(source, &boot_dir.join("initramfs"), "initramfs"))
            .transpose()?;

        let mut staged = KernelOptions {
            path: kernel,
            format: configured.format,
            initramfs,
            command_line: configured.command_line.clone(),
        };
        staged.format = staged.resolve_format()?;
        staged.sanitize()?;

        Ok(Some(staged))
    }

    fn stage_file(&self, source: &Path, destination: &Path, label: &str) -> BoxliteResult<PathBuf> {
        if !source.is_file() {
            return Err(BoxliteError::Config(format!(
                "custom {label} must be a regular file: {}",
                source.display()
            )));
        }

        let source = source.canonicalize().map_err(|error| {
            BoxliteError::Config(format!(
                "failed to resolve custom {label} {}: {error}",
                source.display()
            ))
        })?;
        if destination
            .canonicalize()
            .is_ok_and(|existing| existing == source)
        {
            return Ok(destination.to_path_buf());
        }

        let temporary = destination.with_extension("staging");
        std::fs::copy(&source, &temporary).map_err(|error| {
            BoxliteError::Storage(format!(
                "failed to stage custom {label} {} at {}: {error}",
                source.display(),
                temporary.display()
            ))
        })?;
        if let Err(error) = std::fs::rename(&temporary, destination) {
            let _ = std::fs::remove_file(&temporary);
            return Err(BoxliteError::Storage(format!(
                "failed to publish staged custom {label} at {}: {error}",
                destination.display()
            )));
        }

        tracing::info!(
            source = %source.display(),
            staged = %destination.display(),
            asset = label,
            "Staged custom boot asset"
        );
        Ok(destination.to_path_buf())
    }
}
