//! Auto-detecting decompressor for OCI layer tarballs.
//!
//! OCI allows both gzip-compressed (`application/vnd.oci.image.layer.v1.tar+gzip`)
//! and uncompressed layer media types. We sniff the 2-byte gzip magic instead
//! of trusting the media type, so the extractor and the diff-ID verifier share
//! one source of truth.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use flate2::read::GzDecoder;
use std::fs;
use std::io::{BufReader, Read};
use std::path::Path;
use tracing::debug;

/// Opens OCI layer tarballs, transparently decompressing gzip when present.
pub(super) struct TarballReader;

impl TarballReader {
    /// Return a reader over the uncompressed tar stream. Detects gzip by the
    /// two-byte magic `1f 8b`; anything else is treated as raw tar.
    pub(super) fn open(tarball_path: &Path) -> BoxliteResult<Box<dyn Read>> {
        let mut header = [0u8; 2];
        {
            let probe = fs::File::open(tarball_path).map_err(|e| {
                BoxliteError::Storage(format!(
                    "Failed to open layer tarball {}: {}",
                    tarball_path.display(),
                    e
                ))
            })?;
            (&probe).take(2).read_exact(&mut header).map_err(|e| {
                BoxliteError::Storage(format!("Failed to read layer header: {}", e))
            })?;
        }

        let file = fs::File::open(tarball_path).map_err(|e| {
            BoxliteError::Storage(format!(
                "Failed to reopen layer tarball {}: {}",
                tarball_path.display(),
                e
            ))
        })?;

        if header == [0x1f, 0x8b] {
            debug!("Detected gzip compression for {}", tarball_path.display());
            Ok(Box::new(GzDecoder::new(BufReader::new(file))))
        } else {
            debug!(
                "Detected uncompressed tarball for {}",
                tarball_path.display()
            );
            Ok(Box::new(BufReader::new(file)))
        }
    }
}
