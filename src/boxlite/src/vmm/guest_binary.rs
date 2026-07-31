//! The `boxlite-guest` binary this process injects, resolved once.
//!
//! The binary is late-bound: [`find_binary`] searches `BOXLITE_RUNTIME_DIR`
//! before the embedded runtime cache, so which file gets injected is decided at
//! run time, not build time. Anything derived from its contents — above all the
//! guest rootfs cache key — must therefore be derived from the file that was
//! actually resolved.
//!
//! [`GuestBinary`] is the single place that resolution happens. Callers take the
//! path and the identity from the same value, so "the binary we hashed" and "the
//! binary we injected" cannot drift apart.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use sha2::{Digest, Sha256};

use super::guest_check::validate_guest_bytes;
use crate::util::find_binary;

/// Hex characters of the content digest used as the identity.
///
/// Matches the width the guest rootfs cache key has always used, so entries
/// cached by earlier builds of the same binary still resolve.
const ID_LEN: usize = 12;

/// The resolved `boxlite-guest` binary and its content identity.
pub struct GuestBinary {
    path: PathBuf,
    id: String,
}

impl GuestBinary {
    /// Resolve, validate and identify the guest binary, once per process.
    ///
    /// Only success is memoised: [`BoxliteError`] is not `Clone`, and caching a
    /// rendered string would flatten a "wrong architecture, rebuild with…"
    /// message into a generic one. A failure here aborts box start anyway, so
    /// retrying the read costs nothing that matters.
    pub fn get() -> BoxliteResult<&'static Self> {
        static INSTANCE: OnceLock<GuestBinary> = OnceLock::new();

        if let Some(binary) = INSTANCE.get() {
            return Ok(binary);
        }
        let resolved = Self::resolve()?;
        // A concurrent caller may have won the race; both computed the same
        // value from the same file, so either is correct.
        Ok(INSTANCE.get_or_init(|| resolved))
    }

    /// Path to inject into a guest rootfs.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Content identity, for cache keys and log fields.
    pub fn id(&self) -> &str {
        &self.id
    }

    fn resolve() -> BoxliteResult<Self> {
        Self::resolve_at(find_binary("boxlite-guest")?)
    }

    /// Identify the binary at `path`.
    ///
    /// Split from [`Self::resolve`] so the read-validate-identify step can be
    /// exercised against a known file, without touching `BOXLITE_RUNTIME_DIR`
    /// or the process-wide cache.
    pub(crate) fn resolve_at(path: PathBuf) -> BoxliteResult<Self> {
        // One read feeds both validation and the digest.
        let started = std::time::Instant::now();
        let bytes = std::fs::read(&path).map_err(|e| {
            BoxliteError::Storage(format!(
                "Cannot read guest binary {}: {}",
                path.display(),
                e
            ))
        })?;
        validate_guest_bytes(&bytes, &path)?;
        let id = hex::encode(Sha256::digest(&bytes))[..ID_LEN].to_string();

        tracing::info!(
            path = %path.display(),
            id = %id,
            size_mb = bytes.len() / (1024 * 1024),
            elapsed_ms = started.elapsed().as_millis() as u64,
            "Resolved guest binary"
        );

        Ok(Self { path, id })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smallest byte sequence `validate_guest_bytes` accepts for this host.
    fn fake_guest(filler: u8) -> Vec<u8> {
        let mut elf = vec![0u8; 128];
        elf[..4].copy_from_slice(&[0x7f, b'E', b'L', b'F']);
        elf[4] = 2; // 64-bit
        let machine: u16 = match std::env::consts::ARCH {
            "x86_64" => 0x3E,
            _ => 0xB7,
        };
        elf[18..20].copy_from_slice(&machine.to_le_bytes());
        elf[64..].fill(filler); // payload the digest must actually cover
        elf
    }

    fn write_guest(dir: &tempfile::TempDir, filler: u8) -> PathBuf {
        let path = dir.path().join("boxlite-guest");
        std::fs::write(&path, fake_guest(filler)).unwrap();
        path
    }

    /// The identity must come from the file's contents.
    ///
    /// NOTE ON VERIFICATION: this cannot be a revert-and-watch-it-fail
    /// reproducer. It calls `resolve_at`, which the fix introduces, so removing
    /// the production change stops it compiling rather than failing it. What was
    /// done instead: mutating `resolve_at` to digest the path rather than the
    /// bytes makes this assertion fire, and a booted VM was shown to rebuild the
    /// rootfs after the guest binary was swapped underneath an unchanged boxlite.
    /// Treat the absent red side as a known gap, not as coverage.
    #[test]
    fn id_tracks_the_bytes_on_disk() {
        let dir = tempfile::tempdir().unwrap();

        let before = GuestBinary::resolve_at(write_guest(&dir, 0xAA)).unwrap();
        let first_id = before.id().to_string();

        // Same path, different contents — as after `make guest`.
        let after = GuestBinary::resolve_at(write_guest(&dir, 0xBB)).unwrap();

        assert_ne!(
            first_id,
            after.id(),
            "a rebuilt guest binary must not keep the previous identity"
        );
        assert_eq!(before.path(), after.path(), "same path, different contents");
    }

    #[test]
    fn id_is_stable_for_unchanged_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_guest(&dir, 0xAA);

        let first = GuestBinary::resolve_at(path.clone()).unwrap();
        let second = GuestBinary::resolve_at(path).unwrap();

        assert_eq!(
            first.id(),
            second.id(),
            "identical bytes must reuse the cached rootfs, not rebuild it"
        );
        assert_eq!(first.id().len(), ID_LEN);
    }

    /// The read lives here now, so its failure must be named here.
    #[test]
    fn a_missing_binary_is_reported_by_path() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("boxlite-guest");

        let error = GuestBinary::resolve_at(missing.clone())
            .err()
            .expect("a missing binary must not resolve");

        assert!(
            error.to_string().contains("Cannot read")
                && error.to_string().contains("boxlite-guest"),
            "error should name the unreadable path: {error}"
        );
    }

    /// Resolution must reject a binary the VM could not run, before it is
    /// injected into a rootfs and cached under a key that looks valid.
    #[test]
    fn a_non_elf_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("boxlite-guest");
        std::fs::write(&path, vec![0u8; 128]).unwrap();

        let error = GuestBinary::resolve_at(path)
            .err()
            .expect("bad magic must not resolve");
        assert!(
            error.to_string().contains("ELF"),
            "error should name the problem: {error}"
        );
    }
}
