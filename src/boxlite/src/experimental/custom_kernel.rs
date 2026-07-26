//! Release-candidate direct Linux boot configuration.

use crate::{BoxliteError, BoxliteResult};
use serde::{Deserialize, Serialize};
use std::io::{ErrorKind, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Attach release-candidate custom-kernel configuration to box options.
///
/// The runtime must also enable
/// [`ExperimentalFeature::CustomKernel`](crate::experimental::ExperimentalFeature::CustomKernel).
pub fn configure(options: &mut crate::BoxOptions, kernel: KernelOptions) {
    options.advanced.kernel = Some(kernel);
}

/// Format of a release-candidate custom Linux kernel image.
///
/// `Auto` recognizes ELF images and the compression formats supported by
/// libkrun. Images without a recognized signature are treated as raw.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum KernelFormat {
    #[default]
    Auto,
    Raw,
    Elf,
    PeGz,
    ImageBz2,
    ImageGz,
    ImageZstd,
}

impl KernelFormat {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Raw => "raw",
            Self::Elf => "elf",
            Self::PeGz => "pe-gz",
            Self::ImageBz2 => "image-bz2",
            Self::ImageGz => "image-gz",
            Self::ImageZstd => "image-zstd",
        }
    }

    fn detect(path: &Path) -> BoxliteResult<Self> {
        const READ_SIZE: usize = 64 * 1024;
        const HEADER_SCAN_LIMIT: u64 = 1024 * 1024;
        const MAX_MAGIC_LEN: usize = 4;

        let mut file = std::fs::File::open(path).map_err(|error| {
            BoxliteError::Config(format!(
                "failed to open custom kernel {}: {error}",
                path.display()
            ))
        })?;
        let mut prefix = [0_u8; 4];
        match file.read_exact(&mut prefix) {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::UnexpectedEof => {}
            Err(error) => {
                return Err(BoxliteError::Config(format!(
                    "failed to read custom kernel {}: {error}",
                    path.display()
                )));
            }
        }
        if prefix == *b"\x7fELF" {
            return Ok(Self::Elf);
        }

        file.seek(SeekFrom::Start(0)).map_err(|error| {
            BoxliteError::Config(format!(
                "failed to inspect custom kernel {}: {error}",
                path.display()
            ))
        })?;

        let signatures: &[(&[u8], Self)] = &[
            (b"BZh", Self::ImageBz2),
            (&[0x28, 0xb5, 0x2f, 0xfd], Self::ImageZstd),
            (
                &[0x1f, 0x8b, 0x08],
                if cfg!(target_arch = "x86_64") {
                    Self::ImageGz
                } else {
                    Self::PeGz
                },
            ),
        ];
        // Linux keeps the x86 setup code within 32 KiB. One MiB leaves ample
        // headroom for PE stubs while preventing an Auto probe from reading an
        // arbitrarily large caller-owned image.
        let mut inspected = file.take(HEADER_SCAN_LIMIT);
        let mut buffer = vec![0_u8; READ_SIZE];
        let mut overlap = Vec::with_capacity(MAX_MAGIC_LEN - 1);
        let mut absolute_offset = 0_u64;

        loop {
            let read = inspected.read(&mut buffer).map_err(|error| {
                BoxliteError::Config(format!(
                    "failed to inspect custom kernel {}: {error}",
                    path.display()
                ))
            })?;
            if read == 0 {
                break;
            }

            let overlap_len = overlap.len();
            let mut window = Vec::with_capacity(overlap_len + read);
            window.extend_from_slice(&overlap);
            window.extend_from_slice(&buffer[..read]);
            let window_offset = absolute_offset.saturating_sub(overlap_len as u64);
            let mut earliest: Option<(u64, Self)> = None;

            for (magic, format) in signatures {
                if let Some(position) = window
                    .windows(magic.len())
                    .position(|candidate| candidate == *magic)
                {
                    let position = window_offset + position as u64;
                    if earliest.is_none_or(|(current, _)| position < current) {
                        earliest = Some((position, *format));
                    }
                }
            }
            if let Some((_, format)) = earliest {
                return Ok(format);
            }

            let keep = window.len().min(MAX_MAGIC_LEN - 1);
            overlap.clear();
            overlap.extend_from_slice(&window[window.len() - keep..]);
            absolute_offset += read as u64;
        }

        Ok(Self::Raw)
    }
}

/// Release-candidate direct Linux boot configuration for a box.
///
/// The kernel and optional initramfs are copied into the box's private boot
/// directory before the shim starts. `command_line`, when set, replaces
/// libkrun's default kernel command line.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct KernelOptions {
    pub path: PathBuf,
    #[serde(default)]
    pub format: KernelFormat,
    #[serde(default)]
    pub initramfs: Option<PathBuf>,
    #[serde(default)]
    pub command_line: Option<String>,
}

impl KernelOptions {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            format: KernelFormat::Auto,
            initramfs: None,
            command_line: None,
        }
    }

    pub fn with_format(mut self, format: KernelFormat) -> Self {
        self.format = format;
        self
    }

    pub fn with_initramfs(mut self, path: impl Into<PathBuf>) -> Self {
        self.initramfs = Some(path.into());
        self
    }

    pub fn with_command_line(mut self, command_line: impl Into<String>) -> Self {
        self.command_line = Some(command_line.into());
        self
    }

    pub(crate) fn resolve_format(&self) -> BoxliteResult<KernelFormat> {
        if self.format == KernelFormat::Auto {
            KernelFormat::detect(&self.path)
        } else {
            Ok(self.format)
        }
    }

    /// Validate persisted configuration without reopening host source files.
    pub(crate) fn sanitize_persisted(&self) -> BoxliteResult<()> {
        self.sanitize_shape()?;

        if self.format != KernelFormat::Auto {
            self.validate_resolved_format(self.format)?;
        }

        Ok(())
    }

    fn sanitize_shape(&self) -> BoxliteResult<()> {
        if self.path.to_str().is_none() {
            return Err(BoxliteError::Config(format!(
                "custom kernel path must be valid UTF-8: {}",
                self.path.display()
            )));
        }

        if let Some(initramfs) = &self.initramfs
            && initramfs.to_str().is_none()
        {
            return Err(BoxliteError::Config(format!(
                "custom initramfs path must be valid UTF-8: {}",
                initramfs.display()
            )));
        }

        if self
            .command_line
            .as_ref()
            .is_some_and(|command_line| command_line.contains('\0'))
        {
            return Err(BoxliteError::Config(
                "custom kernel command line must not contain a NUL byte".to_string(),
            ));
        }

        Ok(())
    }

    /// Validate the caller-owned source files at the ingestion boundary.
    pub(crate) fn sanitize(&self) -> BoxliteResult<()> {
        self.sanitize_shape()?;

        if !self.path.is_file() {
            return Err(BoxliteError::Config(format!(
                "custom kernel must be a regular file: {}",
                self.path.display()
            )));
        }
        if let Some(initramfs) = &self.initramfs
            && !initramfs.is_file()
        {
            return Err(BoxliteError::Config(format!(
                "custom initramfs must be a regular file: {}",
                initramfs.display()
            )));
        }

        let resolved = self.resolve_format()?;
        self.validate_resolved_format(resolved)
    }

    fn validate_resolved_format(&self, resolved: KernelFormat) -> BoxliteResult<()> {
        #[cfg(target_arch = "x86_64")]
        if !matches!(
            resolved,
            KernelFormat::Raw
                | KernelFormat::Elf
                | KernelFormat::ImageBz2
                | KernelFormat::ImageGz
                | KernelFormat::ImageZstd
        ) {
            return Err(BoxliteError::Config(format!(
                "custom kernel format '{}' is not supported on x86_64",
                resolved.as_str()
            )));
        }
        #[cfg(target_arch = "aarch64")]
        if !matches!(resolved, KernelFormat::Raw | KernelFormat::PeGz) {
            return Err(BoxliteError::Config(format!(
                "custom kernel format '{}' is not supported on {}",
                resolved.as_str(),
                std::env::consts::ARCH
            )));
        }
        #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
        return Err(BoxliteError::Unsupported(format!(
            "custom kernels are not supported on {}",
            std::env::consts::ARCH
        )));

        #[cfg(target_arch = "x86_64")]
        if resolved == KernelFormat::Raw
            && (self.initramfs.is_some() || self.command_line.is_some())
        {
            return Err(BoxliteError::Config(
                "raw custom kernels on x86_64 do not support an initramfs or custom command line"
                    .to_string(),
            ));
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auto_detects_host_compressed_image_format() {
        let temp = tempfile::tempdir().unwrap();
        let kernel = temp.path().join("kernel-image");
        std::fs::write(&kernel, b"boot-header\x1f\x8b\x08compressed-kernel").unwrap();
        let options = KernelOptions::new(kernel);

        let format = options.resolve_format().unwrap();

        #[cfg(target_arch = "x86_64")]
        assert_eq!(format, KernelFormat::ImageGz);
        #[cfg(target_arch = "aarch64")]
        assert_eq!(format, KernelFormat::PeGz);
    }

    #[test]
    fn auto_detection_is_bounded_to_the_header() {
        const EXPECTED_HEADER_LIMIT: usize = 1024 * 1024;

        let temp = tempfile::tempdir().unwrap();
        let kernel = temp.path().join("kernel-image");
        let mut image = vec![0_u8; EXPECTED_HEADER_LIMIT];
        image.extend_from_slice(b"\x1f\x8b\x08compressed-kernel");
        std::fs::write(&kernel, image).unwrap();

        let format = KernelOptions::new(kernel).resolve_format().unwrap();

        assert_eq!(format, KernelFormat::Raw);
    }
}
