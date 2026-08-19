//! Durable capture of the container init process's output.
//!
//! Only the startup barrier lives here so far: the `begin` record that must be
//! on disk before the workload can produce a byte. Nothing yet streams payload
//! into the same file.

use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use boxlite_shared::LogCapture;
use chrono::{SecondsFormat, Utc};
use uuid::Uuid;

/// Metadata rides a private stream name rather than `stdout`/`stderr` so a
/// workload cannot forge it by printing matching text.
const METADATA_STREAM: &str = "boxlite";

/// Capture state for one `Container.Init` attempt.
#[derive(Debug)]
pub(crate) struct Capture {
    run_id: Uuid,
    log_path: PathBuf,
}

impl Capture {
    /// Parse the host's capture request, rejecting a malformed run id here at
    /// the gRPC boundary rather than carrying an unvalidated string inward.
    pub(crate) fn from_request(
        log_capture: Option<LogCapture>,
        log_path: PathBuf,
    ) -> BoxliteResult<Option<Self>> {
        let Some(log_capture) = log_capture else {
            return Ok(None);
        };
        let run_id = Uuid::parse_str(&log_capture.run_id).map_err(|error| {
            BoxliteError::Config(format!(
                "log_capture.run_id must be a UUID, got {:?}: {error}",
                log_capture.run_id
            ))
        })?;
        Ok(Some(Self { run_id, log_path }))
    }

    pub(crate) fn run_id(&self) -> Uuid {
        self.run_id
    }

    /// Put `begin` on disk, durably, before the container is allowed to run.
    ///
    /// The fsync is what lets a reader tell "capture never started" from
    /// "capture started and its record was lost": once this returns, a file
    /// without `begin` can only mean the former.
    ///
    /// `O_NOFOLLOW` applies to the final component, so a symlink planted at the
    /// log path fails the call instead of redirecting the write.
    pub(crate) fn write_begin(&self) -> BoxliteResult<()> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .custom_flags(nix::libc::O_NOFOLLOW)
            .open(&self.log_path)
            .map_err(|error| self.io_error("open", error))?;
        file.write_all(self.begin_record()?.as_bytes())
            .map_err(|error| self.io_error("write", error))?;
        file.sync_all()
            .map_err(|error| self.io_error("fsync", error))
    }

    fn begin_record(&self) -> BoxliteResult<String> {
        let payload = serde_json::to_string(&MetadataRecord {
            run: self.run_id.to_string(),
            event: "begin",
        })?;
        Ok(format!(
            "{} {METADATA_STREAM} F {payload}\n",
            Utc::now().to_rfc3339_opts(SecondsFormat::Nanos, true)
        ))
    }

    fn io_error(&self, action: &str, error: std::io::Error) -> BoxliteError {
        BoxliteError::Internal(format!(
            "failed to {action} capture log {}: {error}",
            self.log_path.display()
        ))
    }
}

/// Serialized rather than built with `json!` so field order is the struct's,
/// matching the order the format documents.
#[derive(serde::Serialize)]
struct MetadataRecord<'a> {
    run: String,
    event: &'a str,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(run_id: &str) -> Option<LogCapture> {
        Some(LogCapture {
            run_id: run_id.to_string(),
        })
    }

    #[test]
    fn absent_log_capture_disables_capture() {
        let capture = Capture::from_request(None, PathBuf::from("/nonexistent")).unwrap();
        assert!(capture.is_none());
    }

    #[test]
    fn malformed_run_id_is_rejected() {
        for bad in ["", "not-a-uuid", "b3f1c0a4-7d2e-4a91-8c55"] {
            let error = Capture::from_request(request(bad), PathBuf::from("/nonexistent"))
                .expect_err("a non-UUID run id must fail Init");
            assert!(
                matches!(error, BoxliteError::Config(_)),
                "expected Config error for {bad:?}, got {error:?}"
            );
        }
    }

    #[test]
    fn begin_record_carries_the_run_id_on_the_private_stream() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("output.log");
        let run_id = "b3f1c0a4-7d2e-4a91-8c55-0e6f2ab41d90";
        let capture = Capture::from_request(request(run_id), path.clone())
            .unwrap()
            .unwrap();

        capture.write_begin().unwrap();

        let written = std::fs::read_to_string(&path).unwrap();
        let (timestamp, rest) = written.trim_end().split_once(' ').unwrap();
        assert!(
            timestamp.ends_with('Z') && timestamp.contains('.'),
            "timestamp must be RFC3339 with fractional seconds, got {timestamp:?}"
        );
        assert_eq!(
            rest,
            format!("boxlite F {{\"run\":\"{run_id}\",\"event\":\"begin\"}}")
        );
    }

    /// The same file spans VM restarts, so a second run must add its own `begin`
    /// rather than replace the first one's.
    #[test]
    fn a_second_run_appends_instead_of_truncating() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("output.log");
        for run in [
            "b3f1c0a4-7d2e-4a91-8c55-0e6f2ab41d90",
            "c4e2d1b5-8e3f-4b02-9d66-1f7a3bc52ea1",
        ] {
            Capture::from_request(request(run), path.clone())
                .unwrap()
                .unwrap()
                .write_begin()
                .unwrap();
        }

        let written = std::fs::read_to_string(&path).unwrap();
        assert_eq!(written.lines().count(), 2);
        assert!(written.contains("b3f1c0a4-7d2e-4a91-8c55-0e6f2ab41d90"));
        assert!(written.contains("c4e2d1b5-8e3f-4b02-9d66-1f7a3bc52ea1"));
    }

    #[test]
    fn a_symlinked_log_path_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target.log");
        let link = dir.path().join("output.log");
        std::fs::write(&target, b"").unwrap();
        std::os::unix::fs::symlink(&target, &link).unwrap();

        let error = Capture::from_request(
            request("b3f1c0a4-7d2e-4a91-8c55-0e6f2ab41d90"),
            link.clone(),
        )
        .unwrap()
        .unwrap()
        .write_begin()
        .expect_err("O_NOFOLLOW must refuse a symlinked log path");

        assert!(matches!(error, BoxliteError::Internal(_)), "{error:?}");
        assert!(
            std::fs::read(&target).unwrap().is_empty(),
            "the symlink target must not have been written through"
        );
    }
}
