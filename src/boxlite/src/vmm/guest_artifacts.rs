//! The three standalone guest artifacts this process packages into a minimal rootfs.
//!
//! `build-guest.sh` + `build-guest-deps.sh` emit `boxlite-guest` plus static
//! `mke2fs`/`resize2fs`. The guest binary is resolved through [`GuestBinary`];
//! the two tools are embedded under distinct host names (`guest-mke2fs`,
//! `guest-resize2fs`) so they never shadow the *host* `mke2fs` bundled by
//! `e2fsprogs-sys` (resolved by `disk/ext4.rs` to build images).
//!
//! [`GuestArtifacts`] is the single place all three are resolved, and the one
//! value that binds the three host paths to their identity. The combined
//! content identity (`id()`) keys the minimal-rootfs cache, so a rebuild of any
//! one artifact moves the key — the same "path and identity from the same value"
//! contract [`GuestBinary`] documents.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use sha2::{Digest, Sha256};

use super::guest_binary::GuestBinary;
use super::guest_check::validate_guest_bytes;
use crate::util::find_binary;

/// Hex characters of the content digest used as the identity.
const ID_LEN: usize = 12;

/// Host-side name the guest `mke2fs` is embedded under.
const HOST_GUEST_MKE2FS: &str = "guest-mke2fs";
/// Host-side name the guest `resize2fs` is embedded under.
const HOST_GUEST_RESIZE2FS: &str = "guest-resize2fs";

/// A resolved guest tool, identified by its host path.
pub struct GuestTool {
    path: PathBuf,
}

impl GuestTool {
    /// Host path to the tool (to be copied into the minimal rootfs).
    pub fn path(&self) -> &Path {
        &self.path
    }
}

/// The three guest artifacts, resolved once with a combined content identity.
pub struct GuestArtifacts {
    guest_path: PathBuf,
    mke2fs: GuestTool,
    resize2fs: GuestTool,
    combined_id: String,
}

impl GuestArtifacts {
    /// Resolve the guest artifacts once per process.
    ///
    /// Only success is memoised, mirroring [`GuestBinary::get`]: a failure here
    /// (e.g. the guest tools were not built) must not be cached as a rendered
    /// string that hides the actionable error. Callers run this in a background
    /// best-effort task, so a retry on a later boot costs nothing that matters.
    pub fn get() -> BoxliteResult<&'static Self> {
        static INSTANCE: OnceLock<GuestArtifacts> = OnceLock::new();

        if let Some(artifacts) = INSTANCE.get() {
            return Ok(artifacts);
        }
        let resolved = Self::resolve()?;
        Ok(INSTANCE.get_or_init(|| resolved))
    }

    /// Host path to the `boxlite-guest` binary.
    pub fn guest_path(&self) -> &Path {
        &self.guest_path
    }

    /// The resolved guest `mke2fs`.
    pub fn mke2fs(&self) -> &GuestTool {
        &self.mke2fs
    }

    /// The resolved guest `resize2fs`.
    pub fn resize2fs(&self) -> &GuestTool {
        &self.resize2fs
    }

    /// Combined content identity, for cache keys and log fields.
    pub fn id(&self) -> &str {
        &self.combined_id
    }

    fn resolve() -> BoxliteResult<Self> {
        let guest = GuestBinary::get()?;
        let mke2fs = find_binary(HOST_GUEST_MKE2FS)?;
        let resize2fs = find_binary(HOST_GUEST_RESIZE2FS)?;
        Self::resolve_at(guest, mke2fs, resize2fs)
    }

    /// Resolve and identify the artifacts from explicit paths.
    ///
    /// Split from [`Self::resolve`] so the read-hash-identify step can be
    /// exercised against known files without touching `BOXLITE_RUNTIME_DIR` or
    /// the process-wide cache.
    pub(crate) fn resolve_at(
        guest: &GuestBinary,
        mke2fs: PathBuf,
        resize2fs: PathBuf,
    ) -> BoxliteResult<Self> {
        let mke2fs_id = content_id(&mke2fs)?;
        let resize2fs_id = content_id(&resize2fs)?;

        let mut hasher = Sha256::new();
        hasher.update(guest.id().as_bytes());
        hasher.update(mke2fs_id.as_bytes());
        hasher.update(resize2fs_id.as_bytes());
        let combined_id = hex::encode(hasher.finalize())[..ID_LEN].to_string();

        tracing::info!(
            guest_id = %guest.id(),
            mke2fs_id = %mke2fs_id,
            resize2fs_id = %resize2fs_id,
            combined_id = %combined_id,
            "Resolved guest artifacts"
        );

        Ok(Self {
            guest_path: guest.path().to_path_buf(),
            mke2fs: GuestTool { path: mke2fs },
            resize2fs: GuestTool { path: resize2fs },
            combined_id,
        })
    }
}

/// First 12 hex chars of a file's SHA-256 content digest.
fn content_id(path: &Path) -> BoxliteResult<String> {
    let bytes = std::fs::read(path).map_err(|e| {
        BoxliteError::Storage(format!("Cannot read guest tool {}: {}", path.display(), e))
    })?;
    // The tools are static ELF binaries the guest will exec; validate the
    // architecture now (mirroring GuestBinary) so a wrong-arch tool fails
    // here with a clear error instead of at exec time with "Exec format error".
    validate_guest_bytes(&bytes, path)?;
    Ok(hex::encode(Sha256::digest(&bytes))[..ID_LEN].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smallest byte sequence `GuestBinary::resolve_at` accepts for this host.
    fn fake_guest(filler: u8) -> Vec<u8> {
        let mut elf = vec![0u8; 128];
        elf[..4].copy_from_slice(&[0x7f, b'E', b'L', b'F']);
        elf[4] = 2; // 64-bit
        let machine: u16 = match std::env::consts::ARCH {
            "x86_64" => 0x3E,
            _ => 0xB7,
        };
        elf[18..20].copy_from_slice(&machine.to_le_bytes());
        elf[64..].fill(filler);
        elf
    }

    fn resolve(dir: &tempfile::TempDir, guest_filler: u8, tool_filler: u8) -> GuestArtifacts {
        let guest_path = dir.path().join("boxlite-guest");
        std::fs::write(&guest_path, fake_guest(guest_filler)).unwrap();
        let guest = GuestBinary::resolve_at(guest_path).unwrap();

        let mke2fs = dir.path().join("guest-mke2fs");
        let resize2fs = dir.path().join("guest-resize2fs");
        std::fs::write(&mke2fs, fake_guest(tool_filler)).unwrap();
        std::fs::write(&resize2fs, fake_guest(tool_filler)).unwrap();

        GuestArtifacts::resolve_at(&guest, mke2fs, resize2fs).unwrap()
    }

    /// The identity must come from the bytes of all three artifacts.
    ///
    /// NOTE ON VERIFICATION: this cannot be a revert-and-watch-it-fail
    /// reproducer — it calls `resolve_at`, which the change introduces, so
    /// removing the production change stops it compiling rather than failing it.
    /// Verified by mutation (digest a path rather than the bytes makes the
    /// assertion fire).
    #[test]
    fn id_tracks_tool_bytes_on_disk() {
        let dir = tempfile::tempdir().unwrap();

        let before = resolve(&dir, 0xAA, 0x11);
        let first_id = before.id().to_string();

        // Same paths, different tool contents — as after `make guest`.
        let after = resolve(&dir, 0xAA, 0x22);

        assert_ne!(
            first_id,
            after.id(),
            "a rebuilt guest tool must not keep the previous identity"
        );
    }

    #[test]
    fn id_is_stable_for_unchanged_bytes() {
        let dir = tempfile::tempdir().unwrap();

        let first = resolve(&dir, 0xAA, 0x11);
        let second = resolve(&dir, 0xAA, 0x11);

        assert_eq!(
            first.id(),
            second.id(),
            "identical bytes must reuse the cached minimal rootfs"
        );
        assert_eq!(first.id().len(), ID_LEN);
    }

    /// Resolution must fail and name the missing tool, so a build without the
    /// guest tools degrades to a logged skip rather than a confusing error.
    #[test]
    fn a_missing_tool_is_reported_by_name() {
        let dir = tempfile::tempdir().unwrap();

        let guest_path = dir.path().join("boxlite-guest");
        std::fs::write(&guest_path, fake_guest(0xAA)).unwrap();
        let guest = GuestBinary::resolve_at(guest_path).unwrap();

        let error = GuestArtifacts::resolve_at(
            &guest,
            dir.path().join("guest-mke2fs"),
            dir.path().join("guest-resize2fs"),
        )
        .err()
        .expect("a missing tool must not resolve");

        assert!(
            error.to_string().contains("Cannot read") && error.to_string().contains("guest-mke2fs"),
            "error should name the unreadable tool: {error}"
        );
    }

    /// A tool the guest could not run must be rejected before it is staged
    /// into the rootfs, not hashed under a cache key that looks valid.
    #[test]
    fn a_non_elf_tool_is_rejected() {
        let dir = tempfile::tempdir().unwrap();

        let guest_path = dir.path().join("boxlite-guest");
        std::fs::write(&guest_path, fake_guest(0xAA)).unwrap();
        let guest = GuestBinary::resolve_at(guest_path).unwrap();

        let mke2fs = dir.path().join("guest-mke2fs");
        let resize2fs = dir.path().join("guest-resize2fs");
        std::fs::write(&mke2fs, vec![0u8; 128]).unwrap();
        std::fs::write(&resize2fs, vec![0u8; 128]).unwrap();

        let error = GuestArtifacts::resolve_at(&guest, mke2fs, resize2fs)
            .err()
            .expect("a non-ELF tool must not resolve");

        assert!(
            error.to_string().contains("ELF"),
            "error should name the problem: {error}"
        );
    }
}
