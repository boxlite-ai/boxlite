//! OCI images blob storage operations.
//!
//! This module provides low-level storage operations for OCI images artifacts:
//! manifests, layers, and config blobs. It handles file I/O, path management,
//! and integrity verification.
//!
//! Does NOT handle:
//! - Image metadata/indexing (ImageIndex's responsibility)
//! - Registry communication (ImageManager's responsibility)
//! - Cache lookup logic (ImageManager's responsibility)

use std::path::{Path, PathBuf};

use oci_client::manifest::OciManifest;

use crate::images::archive::LayerExtractor;
use crate::runtime::layout::ImageFilesystemLayout;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};

// ============================================================================
// IMAGE STORE
// ============================================================================

/// Manages persistent storage of OCI images blobs.
///
/// Provides low-level operations for storing and loading images artifacts
/// (manifests, layers, configs) with digest-based naming and integrity
/// verification.
pub struct ImageStorage {
    layout: ImageFilesystemLayout,
}

impl std::fmt::Debug for ImageStorage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImageStorage")
            .field("images_dir", &self.layout.root())
            .finish()
    }
}

impl ImageStorage {
    /// Create new images store for the given images directory
    pub fn new(images_dir: PathBuf) -> BoxliteResult<Self> {
        let layout = ImageFilesystemLayout::new(images_dir);
        layout.prepare()?;
        Ok(Self { layout })
    }

    // ========================================================================
    // MANIFEST OPERATIONS [atomic, &self]
    // ========================================================================

    /// Save manifest to disk using digest as filename.
    ///
    /// **Mutability**: Atomic - writes file only if it doesn't exist, safe for
    /// concurrent access (idempotent check-then-write).
    pub fn save_manifest(&self, manifest: &OciManifest, digest: &str) -> BoxliteResult<()> {
        let manifest_path = self.manifest_path(digest);

        if manifest_path.exists() {
            tracing::debug!("Manifest already exists: {}", digest);
            return Ok(());
        }

        let manifest_json = serde_json::to_string_pretty(manifest)
            .map_err(|e| BoxliteError::Storage(format!("Failed to serialize manifest: {}", e)))?;

        std::fs::write(&manifest_path, manifest_json).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to write manifest to {}: {}",
                manifest_path.display(),
                e
            ))
        })?;

        tracing::debug!("Saved manifest: {}", digest);
        Ok(())
    }

    /// Load manifest from disk by digest.
    ///
    /// **Mutability**: Immutable - reads file only, no state changes.
    pub fn load_manifest(&self, digest: &str) -> BoxliteResult<OciManifest> {
        let manifest_path = self.manifest_path(digest);

        if !manifest_path.exists() {
            return Err(BoxliteError::Storage(format!(
                "Manifest not found: {}",
                digest
            )));
        }

        let manifest_json = std::fs::read_to_string(&manifest_path).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to read manifest {}: {}",
                manifest_path.display(),
                e
            ))
        })?;

        let manifest: OciManifest = serde_json::from_str(&manifest_json)
            .map_err(|e| BoxliteError::Storage(format!("Failed to parse manifest: {}", e)))?;

        Ok(manifest)
    }

    /// Check if manifest exists on disk.
    ///
    /// **Mutability**: Immutable - reads filesystem only, no state changes.
    pub fn has_manifest(&self, digest: &str) -> bool {
        self.manifest_path(digest).exists()
    }

    /// Get path to manifest file.
    ///
    /// **Mutability**: Immutable - pure path computation, no I/O.
    pub fn manifest_path(&self, digest: &str) -> PathBuf {
        let filename = digest.replace(':', "-");
        self.layout
            .manifests_dir()
            .join(format!("{}.json", filename))
    }

    // ========================================================================
    // LAYER OPERATIONS [mixed mutability]
    // ========================================================================

    /// Check if layer tarball exists on disk.
    ///
    /// **Mutability**: Immutable - reads filesystem only, no state changes.
    pub fn has_layer(&self, digest: &str) -> bool {
        self.layer_tarball_path(digest).exists()
    }

    /// Verify layer integrity by computing SHA256 hash and comparing.
    ///
    /// **Mutability**: Immutable - reads file and computes hash, no state changes.
    pub async fn verify_layer(&self, digest: &str) -> BoxliteResult<bool> {
        use sha2::{Digest, Sha256};

        let layer_path = self.layer_tarball_path(digest);

        if !layer_path.exists() {
            return Ok(false);
        }

        // Read file and compute hash
        let file_data = tokio::fs::read(&layer_path).await.map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to read layer {} for verification: {}",
                layer_path.display(),
                e
            ))
        })?;

        let mut hasher = Sha256::new();
        hasher.update(&file_data);
        let computed_hash = format!("sha256:{:x}", hasher.finalize());

        if computed_hash != digest {
            tracing::error!(
                "Layer integrity check failed:\n  Expected: {}\n  Computed: {}\n  File size: {} bytes",
                digest,
                computed_hash,
                file_data.len()
            );
            return Ok(false);
        }

        Ok(true)
    }

    /// Get path to layer tarball.
    ///
    /// **Mutability**: Immutable - pure path computation, no I/O.
    pub fn layer_tarball_path(&self, digest: &str) -> PathBuf {
        let filename = digest.replace(':', "-");
        self.layout
            .layers_dir()
            .join(format!("{}.tar.gz", filename))
    }

    /// Get path to extracted layer directory.
    ///
    /// **Mutability**: Immutable - pure path computation, no I/O.
    pub fn layer_extracted_path(&self, digest: &str) -> PathBuf {
        let filename = digest.replace(':', "-");
        self.layout.extracted_dir().join(filename)
    }

    /// Extract layer tarball to cache directory (keeping whiteout markers).
    ///
    /// **Mutability**: Atomic - uses temp directory + atomic rename pattern.
    /// Safe for concurrent access; only one thread wins, losers clean up.
    ///
    /// CRITICAL: This extracts the layer but does NOT process whiteouts.
    /// Whiteout markers (.wh.* files) are kept in the cached layer because:
    /// - They indicate files to delete from LOWER layers
    /// - Processing them on individual layers would lose deletion information
    /// - Whiteouts are processed INLINE when copying layers (not after merge)
    ///
    /// Example:
    /// - layer0 has: /bin/sh, /bin/bash
    /// - layer1 has: /bin/.wh.sh (delete sh), /bin/newfile
    /// - If we process whiteouts on layer1 alone, .wh.sh is removed but sh isn't deleted
    /// - When copying layer1 on top of layer0: .wh.sh triggers deletion of sh
    /// - Correct: keep .wh.sh in cached layer1, process during copy operation
    pub fn extract_layer(&self, digest: &str, tarball_path: &Path) -> BoxliteResult<()> {
        let extracted_path = self.layer_extracted_path(digest);

        // Fast path: already extracted
        if extracted_path.exists() {
            tracing::trace!("Layer {} already extracted (cached)", digest);
            return Ok(());
        }

        // Extract to a unique temp directory to avoid race conditions
        // Use PID + random UUID to ensure uniqueness across threads and processes
        let temp_suffix = format!("{}.extracting", uuid::Uuid::new_v4().simple());
        let temp_path = extracted_path.with_extension(temp_suffix);

        // Create temp directory
        std::fs::create_dir_all(&temp_path).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create temp extraction directory {}: {}",
                temp_path.display(),
                e
            ))
        })?;

        // Extract tarball to temp directory - keep .wh.* files!
        if let Err(e) =
            LayerExtractor::new(&temp_path).extract_tarball_preserving_whiteouts(tarball_path)
        {
            // Clean up temp dir on extraction failure
            let _ = std::fs::remove_dir_all(&temp_path);
            return Err(e);
        }

        // Atomic rename: only one thread/process wins
        match std::fs::rename(&temp_path, &extracted_path) {
            Ok(()) => {
                tracing::debug!(
                    "Extracted layer {} (with whiteout markers) to {}",
                    digest,
                    extracted_path.display()
                );
            }
            Err(e) => {
                // Another thread/process won the race - clean up our temp dir
                let _ = std::fs::remove_dir_all(&temp_path);

                // Check if the winner succeeded (directory exists)
                if extracted_path.exists() {
                    tracing::debug!(
                        "Layer {} already extracted by another thread/process",
                        digest
                    );
                } else {
                    // Neither we nor the winner succeeded - this is an error
                    return Err(BoxliteError::Storage(format!(
                        "Failed to rename temp directory to {}: {} (and no other extraction succeeded)",
                        extracted_path.display(),
                        e
                    )));
                }
            }
        }

        Ok(())
    }

    /// Start a staged download for a layer blob.
    ///
    /// **Mutability**: Atomic - creates unique temp file with random suffix.
    /// Safe for concurrent access; each caller gets its own temp file.
    ///
    /// Returns a StagedDownload handle that manages the temp file lifecycle.
    /// Use `staged.file()` to get the file for writing.
    pub async fn stage_layer_download(
        &self,
        digest: &str,
        expected_size: i64,
    ) -> BoxliteResult<StagedDownload> {
        // Extract expected hash from digest
        let expected_hash = digest
            .strip_prefix("sha256:")
            .ok_or_else(|| BoxliteError::Storage("Invalid digest format, expected sha256:".into()))?
            .to_string();

        // Generate random suffix to prevent collision in parallel downloads
        let random_suffix = uuid::Uuid::new_v4().simple();
        let filename = digest.replace(':', "-");
        let staged_path = self
            .layout
            .layers_dir()
            .join(format!("{}.{}.downloading", filename, random_suffix));

        let file = tokio::fs::File::create(&staged_path).await.map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create temp file {}: {}",
                staged_path.display(),
                e
            ))
        })?;

        Ok(StagedDownload::new(
            staged_path,
            self.layer_tarball_path(digest),
            expected_hash,
            expected_size,
            file,
        ))
    }

    // ========================================================================
    // CONFIG OPERATIONS [mixed mutability]
    // ========================================================================

    /// Check if config blob exists on disk.
    ///
    /// **Mutability**: Immutable - reads filesystem only, no state changes.
    pub fn has_config(&self, digest: &str) -> bool {
        self.config_path(digest).exists()
    }

    /// Load config blob from disk.
    ///
    /// **Mutability**: Immutable - reads file only, no state changes.
    #[allow(dead_code)]
    pub fn load_config(&self, digest: &str) -> BoxliteResult<String> {
        let config_path = self.config_path(digest);

        if !config_path.exists() {
            return Err(BoxliteError::Storage(format!(
                "Config blob not found: {}. Did you call pull() first?",
                digest
            )));
        }

        std::fs::read_to_string(&config_path).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to read config {}: {}",
                config_path.display(),
                e
            ))
        })
    }

    /// Get path to config blob.
    ///
    /// **Mutability**: Immutable - pure path computation, no I/O.
    pub fn config_path(&self, digest: &str) -> PathBuf {
        // Config blobs stored in configs directory
        self.layout
            .configs_dir()
            .join(format!("{}.json", digest.replace(':', "-")))
    }

    /// Create file for writing config blob.
    ///
    /// **Mutability**: Atomic - creates file at content-addressed path.
    /// Safe for concurrent access; same digest always writes to same path.
    ///
    /// Start a staged download for a config blob.
    ///
    /// **Mutability**: Atomic - creates unique temp file with random suffix.
    /// Safe for concurrent access; each caller gets its own temp file.
    ///
    /// Returns a StagedDownload handle that manages the temp file lifecycle.
    /// Use `staged.file()` to get the file for writing, then `staged.commit()`
    /// to verify and atomically move to final location.
    pub async fn stage_config_download(&self, digest: &str) -> BoxliteResult<StagedDownload> {
        // Extract expected hash from digest
        let expected_hash = digest
            .strip_prefix("sha256:")
            .ok_or_else(|| BoxliteError::Storage("Invalid digest format, expected sha256:".into()))?
            .to_string();

        // Ensure parent directory exists
        let config_path = self.config_path(digest);
        if let Some(parent) = config_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to create config directory {}: {}",
                    parent.display(),
                    e
                ))
            })?;
        }

        // Generate random suffix to prevent collision in parallel downloads
        let random_suffix = uuid::Uuid::new_v4().simple();
        let filename = digest.replace(':', "-");
        let staged_path = self
            .layout
            .configs_dir()
            .join(format!("{}.{}.downloading", filename, random_suffix));

        let file = tokio::fs::File::create(&staged_path).await.map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to create temp file {}: {}",
                staged_path.display(),
                e
            ))
        })?;

        Ok(StagedDownload::new(
            staged_path,
            config_path,
            expected_hash,
            0, // Config size not tracked; skip size validation
            file,
        ))
    }

    // ========================================================================
    // UTILITY OPERATIONS [immutable, &self]
    // ========================================================================

    /// Verify all blobs for given layer digests exist on disk.
    ///
    /// **Mutability**: Immutable - reads filesystem only, no state changes.
    pub fn verify_blobs_exist(&self, layer_digests: &[String]) -> bool {
        layer_digests.iter().all(|digest| self.has_layer(digest))
    }

    /// Get the images directory path.
    ///
    /// **Mutability**: Immutable - returns reference to stored path.
    #[allow(dead_code)]
    pub fn images_dir(&self) -> &Path {
        self.layout.root()
    }

    /// Get the layers directory path.
    ///
    /// **Mutability**: Immutable - returns path to layers directory.
    #[allow(unused)]
    pub fn layer_dir(&self) -> PathBuf {
        self.layout.layers_dir()
    }

    /// Compute cache directory for a local OCI bundle.
    ///
    /// Delegates to `ImageFilesystemLayout::local_bundle_cache_dir`.
    pub fn local_bundle_cache_dir(
        &self,
        bundle_path: &std::path::Path,
        manifest_digest: &str,
    ) -> PathBuf {
        self.layout
            .local_bundle_cache_dir(bundle_path, manifest_digest)
    }
}

// ============================================================================
// HASHING WRITER
// ============================================================================

/// AsyncWrite wrapper that computes SHA256 of all bytes written through it.
///
/// Feeds every successfully written byte through a SHA256 hasher, providing
/// inline digest verification without requiring a post-download re-read.
///
/// Compatible with `oci-client`'s `pull_blob` which requires `T: AsyncWrite + Unpin`.
pub struct HashingWriter<W> {
    inner: W,
    hasher: sha2::Sha256,
    bytes_written: u64,
}

impl<W> HashingWriter<W> {
    pub fn new(inner: W) -> Self {
        use sha2::Digest;
        Self {
            inner,
            hasher: sha2::Sha256::new(),
            bytes_written: 0,
        }
    }

    /// Consume the writer and return (inner_writer, hex_hash, bytes_written).
    pub fn finalize(self) -> (W, String, u64) {
        use sha2::Digest;
        let hash = format!("{:x}", self.hasher.finalize());
        (self.inner, hash, self.bytes_written)
    }
}

impl<W: tokio::io::AsyncWrite + Unpin> tokio::io::AsyncWrite for HashingWriter<W> {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        use sha2::Digest;
        let this = self.get_mut();
        match std::pin::Pin::new(&mut this.inner).poll_write(cx, buf) {
            std::task::Poll::Ready(Ok(n)) => {
                // Only hash bytes that were actually written to the inner writer
                this.hasher.update(&buf[..n]);
                this.bytes_written += n as u64;
                std::task::Poll::Ready(Ok(n))
            }
            other => other,
        }
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        std::pin::Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

// ============================================================================
// STAGED DOWNLOAD
// ============================================================================

/// Handle for an in-progress download with atomic commit semantics
///
/// Downloads to a temp file first, then verifies integrity and atomically
/// moves to the final location. Temp file uses random suffix to prevent
/// collision in parallel downloads.
///
/// # Example
/// ```ignore
/// let mut staged = store.stage_layer_download(digest).await?;
/// // Write data to file...
/// client.pull_blob(reference, descriptor, staged.file()).await?;
/// if staged.commit().await? {
///     println!("Download verified and committed");
/// } else {
///     println!("Verification failed, temp file cleaned up");
/// }
/// ```
pub struct StagedDownload {
    staged_path: PathBuf,
    final_path: PathBuf,
    expected_hash: String,
    /// Expected blob size from manifest descriptor. Values <= 0 skip size validation.
    expected_size: i64,
    writer: Option<HashingWriter<tokio::fs::File>>,
}

impl StagedDownload {
    /// Create a new staged download
    fn new(
        staged_path: PathBuf,
        final_path: PathBuf,
        expected_hash: String,
        expected_size: i64,
        file: tokio::fs::File,
    ) -> Self {
        Self {
            staged_path,
            final_path,
            expected_hash,
            expected_size,
            writer: Some(HashingWriter::new(file)),
        }
    }

    /// Get mutable reference to the hashing writer for writing blob data.
    ///
    /// The writer computes SHA256 inline as bytes are written, eliminating
    /// the need for a post-download re-read.
    pub fn file(&mut self) -> &mut HashingWriter<tokio::fs::File> {
        self.writer.as_mut().expect("writer already consumed")
    }

    /// Get the staged file path (for debugging/logging)
    #[allow(unused)]
    pub fn staged_path(&self) -> &Path {
        &self.staged_path
    }

    #[allow(unused)]
    pub fn final_path(&self) -> &Path {
        &self.final_path
    }

    /// Verify integrity and atomically move to final location.
    ///
    /// Reads the hash computed inline by `HashingWriter` during the download —
    /// no post-download re-read is needed. This is an independent verification
    /// layer from `oci-client`'s own inline digest check.
    ///
    /// Returns Ok(true) if verification passed and file was committed,
    /// Ok(false) if verification failed (temp file is cleaned up).
    /// Consumes self to prevent further use after commit.
    pub async fn commit(mut self) -> BoxliteResult<bool> {
        // Finalize the hashing writer to get computed hash and byte count
        let writer = self
            .writer
            .take()
            .ok_or_else(|| BoxliteError::Storage("writer already consumed".into()))?;
        let (_file, computed_hash, bytes_written) = writer.finalize();

        if !self.staged_path.exists() {
            return Err(BoxliteError::Storage(format!(
                "Temp file not found: {}",
                self.staged_path.display()
            )));
        }

        // Size validation (fail fast before hash comparison)
        if self.expected_size > 0 && bytes_written != self.expected_size as u64 {
            tracing::error!(
                "Blob size mismatch: expected {} bytes, got {} bytes",
                self.expected_size,
                bytes_written
            );
            let _ = tokio::fs::remove_file(&self.staged_path).await;
            return Ok(false);
        }

        if computed_hash != self.expected_hash {
            // Verification failed - clean up temp file
            let _ = tokio::fs::remove_file(&self.staged_path).await;
            return Ok(false);
        }

        // Atomically move temp file to final location
        tokio::fs::rename(&self.staged_path, &self.final_path)
            .await
            .map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to move {} to {}: {}",
                    self.staged_path.display(),
                    self.final_path.display(),
                    e
                ))
            })?;

        Ok(true)
    }

    /// Clean up the temp file without committing
    ///
    /// Call this on download failure or cancellation.
    pub async fn abort(mut self) {
        self.writer.take();
        let _ = tokio::fs::remove_file(&self.staged_path).await;
    }
}

// ============================================================================
// TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn tar_with_whiteout_marker() -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());

        let mut dir = tar::Header::new_gnu();
        dir.set_path("bin").unwrap();
        dir.set_entry_type(tar::EntryType::Directory);
        dir.set_mode(0o755);
        dir.set_size(0);
        dir.set_cksum();
        builder.append(&dir, &[][..]).unwrap();

        let mut whiteout = tar::Header::new_gnu();
        whiteout.set_path("bin/.wh.sh").unwrap();
        whiteout.set_entry_type(tar::EntryType::Regular);
        whiteout.set_mode(0o644);
        whiteout.set_size(0);
        whiteout.set_cksum();
        builder.append(&whiteout, &[][..]).unwrap();

        let content = b"upper";
        let mut file = tar::Header::new_gnu();
        file.set_path("bin/new-tool").unwrap();
        file.set_entry_type(tar::EntryType::Regular);
        file.set_mode(0o755);
        file.set_size(content.len() as u64);
        file.set_cksum();
        builder.append(&file, &content[..]).unwrap();

        builder.into_inner().unwrap()
    }

    #[test]
    fn test_store_new_creates_directories() {
        let temp_dir = tempfile::tempdir().unwrap();
        let images_dir = temp_dir.path().join("images");

        let store = ImageStorage::new(images_dir.clone()).unwrap();

        assert!(images_dir.join("manifests").exists());
        assert!(images_dir.join("layers").exists());
        assert_eq!(store.images_dir(), images_dir);
    }

    #[test]
    fn test_manifest_path() {
        let temp_dir = tempfile::tempdir().unwrap();
        let store = ImageStorage::new(temp_dir.path().to_path_buf()).unwrap();

        let path = store.manifest_path("sha256:abc123");
        assert_eq!(path, temp_dir.path().join("manifests/sha256-abc123.json"));
    }

    #[test]
    fn test_layer_path() {
        let temp_dir = tempfile::tempdir().unwrap();
        let store = ImageStorage::new(temp_dir.path().to_path_buf()).unwrap();

        let path = store.layer_tarball_path("sha256:layer1");
        assert_eq!(path, temp_dir.path().join("layers/sha256-layer1.tar.gz"));
    }

    #[test]
    fn test_extract_layer_preserves_whiteout_markers_for_cache() {
        let temp_dir = tempfile::tempdir().unwrap();
        let store = ImageStorage::new(temp_dir.path().to_path_buf()).unwrap();
        let digest = "sha256:whiteout-layer";
        let tar_path = temp_dir.path().join("layer.tar");
        std::fs::write(&tar_path, tar_with_whiteout_marker()).unwrap();

        store.extract_layer(digest, &tar_path).unwrap();

        let extracted = store.layer_extracted_path(digest);
        assert!(extracted.join("bin/.wh.sh").exists());
        assert_eq!(
            std::fs::read(extracted.join("bin/new-tool")).unwrap(),
            b"upper"
        );
    }

    #[test]
    fn test_config_path() {
        let temp_dir = tempfile::tempdir().unwrap();
        let store = ImageStorage::new(temp_dir.path().to_path_buf()).unwrap();

        let path = store.config_path("sha256:config1");
        assert_eq!(path, temp_dir.path().join("configs/sha256-config1.json"));
    }

    #[test]
    fn test_has_manifest() {
        let temp_dir = tempfile::tempdir().unwrap();
        let store = ImageStorage::new(temp_dir.path().to_path_buf()).unwrap();

        assert!(!store.has_manifest("sha256:abc123"));

        // Create a manifest file
        let manifest_path = store.manifest_path("sha256:abc123");
        std::fs::write(manifest_path, "{}").unwrap();

        assert!(store.has_manifest("sha256:abc123"));
    }

    #[test]
    fn test_has_layer() {
        let temp_dir = tempfile::tempdir().unwrap();
        let store = ImageStorage::new(temp_dir.path().to_path_buf()).unwrap();

        assert!(!store.has_layer("sha256:layer1"));

        // Create a layer file
        let layer_path = store.layer_tarball_path("sha256:layer1");
        std::fs::write(layer_path, b"fake layer data").unwrap();

        assert!(store.has_layer("sha256:layer1"));
    }

    #[test]
    fn test_has_config() {
        let temp_dir = tempfile::tempdir().unwrap();
        let store = ImageStorage::new(temp_dir.path().to_path_buf()).unwrap();

        assert!(!store.has_config("sha256:config1"));

        // Create a config file
        let config_path = store.config_path("sha256:config1");
        std::fs::write(config_path, "{}").unwrap();

        assert!(store.has_config("sha256:config1"));
    }

    #[test]
    fn test_load_config() {
        let temp_dir = tempfile::tempdir().unwrap();
        let store = ImageStorage::new(temp_dir.path().to_path_buf()).unwrap();

        let config_path = store.config_path("sha256:config1");
        std::fs::write(&config_path, r#"{"foo": "bar"}"#).unwrap();

        let config = store.load_config("sha256:config1").unwrap();
        assert_eq!(config, r#"{"foo": "bar"}"#);
    }

    #[tokio::test]
    async fn test_hashing_writer_produces_correct_sha256() {
        use sha2::Digest;
        use tokio::io::AsyncWriteExt;

        let data = b"hello world - hashing writer test";
        let expected_hash = format!("{:x}", sha2::Sha256::digest(data));

        let buf = Vec::new();
        let mut writer = HashingWriter::new(buf);
        writer.write_all(data).await.unwrap();

        let (inner, hash, bytes_written) = writer.finalize();
        assert_eq!(hash, expected_hash);
        assert_eq!(bytes_written, data.len() as u64);
        assert_eq!(inner, data.to_vec());
    }

    /// Helper: create a staged download with known content, expected hash, and expected size.
    /// Returns (StagedDownload, actual_content_bytes).
    async fn create_staged_with_content(
        store: &ImageStorage,
        content: &[u8],
        expected_size: i64,
    ) -> StagedDownload {
        use sha2::Digest;
        use tokio::io::AsyncWriteExt;

        let hash = format!("{:x}", sha2::Sha256::digest(content));
        let digest = format!("sha256:{}", hash);
        let mut staged = store
            .stage_layer_download(&digest, expected_size)
            .await
            .unwrap();
        staged.file().write_all(content).await.unwrap();
        staged.file().flush().await.unwrap();
        staged
    }

    #[tokio::test]
    async fn test_staged_download_commit_correct_size() {
        let temp_dir = tempfile::tempdir().unwrap();
        let store = ImageStorage::new(temp_dir.path().to_path_buf()).unwrap();

        let content = b"hello world";
        let staged = create_staged_with_content(&store, content, content.len() as i64).await;
        assert!(
            staged.commit().await.unwrap(),
            "commit should succeed with correct size and hash"
        );
    }

    #[tokio::test]
    async fn test_staged_download_commit_wrong_size() {
        let temp_dir = tempfile::tempdir().unwrap();
        let store = ImageStorage::new(temp_dir.path().to_path_buf()).unwrap();

        let content = b"hello world";
        // Expect 5 bytes but write 11
        let staged = create_staged_with_content(&store, content, 5).await;
        assert!(
            !staged.commit().await.unwrap(),
            "commit should fail with wrong size"
        );
    }

    #[tokio::test]
    async fn test_staged_download_commit_zero_size_skips_validation() {
        let temp_dir = tempfile::tempdir().unwrap();
        let store = ImageStorage::new(temp_dir.path().to_path_buf()).unwrap();

        let content = b"hello world";
        // size=0 means unknown, should skip size validation
        let staged = create_staged_with_content(&store, content, 0).await;
        assert!(
            staged.commit().await.unwrap(),
            "commit should succeed when size=0 (skip validation)"
        );
    }

    #[tokio::test]
    async fn test_staged_download_commit_negative_size_skips_validation() {
        let temp_dir = tempfile::tempdir().unwrap();
        let store = ImageStorage::new(temp_dir.path().to_path_buf()).unwrap();

        let content = b"hello world";
        // size=-1 means unknown, should skip size validation
        let staged = create_staged_with_content(&store, content, -1).await;
        assert!(
            staged.commit().await.unwrap(),
            "commit should succeed when size<0 (skip validation)"
        );
    }

    #[test]
    fn test_verify_blobs_exist() {
        let temp_dir = tempfile::tempdir().unwrap();
        let store = ImageStorage::new(temp_dir.path().to_path_buf()).unwrap();

        let layer1 = "sha256:layer1".to_string();
        let layer2 = "sha256:layer2".to_string();

        // No layers exist yet
        assert!(!store.verify_blobs_exist(&[layer1.clone(), layer2.clone()]));

        // Create first layer
        std::fs::write(store.layer_tarball_path(&layer1), b"data1").unwrap();
        assert!(!store.verify_blobs_exist(&[layer1.clone(), layer2.clone()]));

        // Create second layer
        std::fs::write(store.layer_tarball_path(&layer2), b"data2").unwrap();
        assert!(store.verify_blobs_exist(&[layer1, layer2]));
    }
}
