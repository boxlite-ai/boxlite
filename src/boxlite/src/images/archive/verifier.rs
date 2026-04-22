//! DiffID verification for OCI layers.
//!
//! DiffID is SHA-256 of the *uncompressed* tar stream, as declared in the OCI
//! image config's `rootfs.diff_ids`. Verifying it catches silent corruption
//! and registry tampering that the content digest (over the compressed blob)
//! cannot detect.

use super::compression::TarballReader;
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::io::Read;
use std::path::Path;

/// Verifies a layer's decompressed byte stream against an expected DiffID.
///
/// Constructed from the `sha256:<hex>` string in the image config; the
/// expensive read happens in [`verify_reader`](Self::verify_reader) or
/// [`verify_tarball`](Self::verify_tarball). Splitting construction from
/// verification means any `Read` source can be checked — in-memory bytes
/// make unit tests trivial.
pub struct LayerVerifier {
    expected_hash: String,
}

impl LayerVerifier {
    /// Parse and validate an OCI DiffID of the form `sha256:<hex>`.
    pub fn new(expected_diff_id: &str) -> BoxliteResult<Self> {
        let expected_hash = expected_diff_id.strip_prefix("sha256:").ok_or_else(|| {
            BoxliteError::Storage("Invalid diff_id format, expected sha256:".into())
        })?;
        if expected_hash.is_empty() {
            return Err(BoxliteError::Storage("Invalid diff_id: empty hash".into()));
        }
        Ok(Self {
            expected_hash: expected_hash.to_string(),
        })
    }

    /// Decompress `tarball_path` and verify its DiffID.
    pub fn verify_tarball(&self, tarball_path: &Path) -> BoxliteResult<bool> {
        let reader = TarballReader::open(tarball_path)?;
        self.verify_reader(reader, Some(tarball_path))
    }

    /// Consume `reader`, hashing every byte with SHA-256. `origin` is used in
    /// the mismatch log message only.
    pub fn verify_reader<R: Read>(
        &self,
        mut reader: R,
        origin: Option<&Path>,
    ) -> BoxliteResult<bool> {
        use sha2::{Digest, Sha256};

        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let n = reader.read(&mut buffer).map_err(|e| {
                BoxliteError::Storage(format!("Failed to read decompressed layer: {}", e))
            })?;
            if n == 0 {
                break;
            }
            hasher.update(&buffer[..n]);
        }
        let computed = format!("{:x}", hasher.finalize());
        if computed != self.expected_hash {
            tracing::error!(
                "DiffID mismatch for {}: expected sha256:{}, computed sha256:{}",
                origin.map(|p| p.display().to_string()).unwrap_or_default(),
                self.expected_hash,
                computed,
            );
            return Ok(false);
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use std::io::Write;

    #[test]
    fn rejects_malformed_diff_id() {
        assert!(LayerVerifier::new("md5:abc").is_err());
        assert!(LayerVerifier::new("sha256:").is_err());
        assert!(LayerVerifier::new("").is_err());
    }

    #[test]
    fn accepts_matching_in_memory_stream() {
        use sha2::Digest;
        let payload = b"boxlite layer verifier test bytes";
        let expected = format!("sha256:{:x}", sha2::Sha256::digest(payload));
        let verifier = LayerVerifier::new(&expected).unwrap();
        assert!(verifier.verify_reader(&payload[..], None).unwrap());
    }

    #[test]
    fn rejects_mismatched_in_memory_stream() {
        let verifier = LayerVerifier::new(
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        )
        .unwrap();
        assert!(!verifier.verify_reader(&b"some bytes"[..], None).unwrap());
    }

    #[test]
    fn verify_tarball_gzipped_matches() {
        use sha2::Digest;
        let tmp = tempfile::tempdir().unwrap();

        let tar_data = b"fake-tar-bytes-for-hashing";
        let expected = format!("sha256:{:x}", sha2::Sha256::digest(tar_data));

        let mut gz = GzEncoder::new(Vec::new(), Compression::default());
        gz.write_all(tar_data).unwrap();
        let gzipped = gz.finish().unwrap();

        let path = tmp.path().join("layer.tar.gz");
        std::fs::write(&path, gzipped).unwrap();

        let verifier = LayerVerifier::new(&expected).unwrap();
        assert!(verifier.verify_tarball(&path).unwrap());
    }

    #[test]
    fn verify_tarball_uncompressed_matches() {
        use sha2::Digest;
        let tmp = tempfile::tempdir().unwrap();

        let tar_data = b"uncompressed-tar-bytes";
        let expected = format!("sha256:{:x}", sha2::Sha256::digest(tar_data));

        let path = tmp.path().join("layer.tar");
        std::fs::write(&path, tar_data).unwrap();

        let verifier = LayerVerifier::new(&expected).unwrap();
        assert!(verifier.verify_tarball(&path).unwrap());
    }

    #[test]
    fn verify_tarball_wrong_hash() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("layer.tar");
        std::fs::write(&path, b"anything").unwrap();

        let verifier = LayerVerifier::new(
            "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        )
        .unwrap();
        assert!(!verifier.verify_tarball(&path).unwrap());
    }
}
