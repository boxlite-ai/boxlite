//! Durable capture of the container init process's output.
//!
//! Only the startup barrier lives here so far: the `begin` record that must be
//! on disk before the workload can produce a byte. Nothing yet streams payload
//! into the same file.

use std::fs::OpenOptions;
use std::io::Write;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;

use std::time::{SystemTime, UNIX_EPOCH};

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use boxlite_shared::LogCapture;
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
    /// Syncing is what lets a reader tell "capture never started" from "capture
    /// started and its record was lost": once this returns, a file without
    /// `begin` can only mean the former. Both syncs are needed for that — the
    /// file's for the record, the parent directory's for the entry naming it.
    ///
    /// `O_NOFOLLOW` applies to the final component, so a symlink planted at the
    /// log path fails the call instead of redirecting the write.
    pub(crate) fn write_begin(&self) -> BoxliteResult<()> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .custom_flags(nix::libc::O_NOFOLLOW)
            .open(&self.log_path)
            .map_err(|error| Self::io_error("open", &self.log_path, error))?;
        file.write_all(self.begin_record()?.as_bytes())
            .map_err(|error| Self::io_error("write", &self.log_path, error))?;
        file.sync_all()
            .map_err(|error| Self::io_error("fsync", &self.log_path, error))?;
        self.sync_parent()
    }

    /// Syncing the file persists its contents, not the directory entry naming
    /// it. On a first run `output.log` is newly created, so without this a host
    /// crash can drop the whole file after `write_begin` returned success —
    /// producing exactly the ambiguity the barrier exists to rule out, a log
    /// with no `begin` that did have capture armed.
    fn sync_parent(&self) -> BoxliteResult<()> {
        let parent = self.log_path.parent().ok_or_else(|| {
            BoxliteError::Internal(format!(
                "capture log path has no parent directory: {}",
                self.log_path.display()
            ))
        })?;
        std::fs::File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(|error| Self::io_error("fsync directory", parent, error))
    }

    fn begin_record(&self) -> BoxliteResult<String> {
        let payload = serde_json::to_string(&MetadataRecord {
            run: self.run_id.to_string(),
            event: "begin",
        })?;
        Ok(format!(
            "{} {METADATA_STREAM} F {payload}\n",
            rfc3339_nanos(SystemTime::now())
        ))
    }

    fn io_error(action: &str, path: &std::path::Path, error: std::io::Error) -> BoxliteError {
        BoxliteError::Internal(format!(
            "failed to {action} capture log {}: {error}",
            path.display()
        ))
    }
}

/// Format a UTC instant as RFC3339 with nine fractional digits, the shape CRI
/// readers expect.
///
/// Hand-rolled rather than pulled from a date crate: this is the guest binary,
/// which ships inside every VM image, and one `format!` plus the civil-date
/// arithmetic below is the whole requirement.
fn rfc3339_nanos(at: SystemTime) -> String {
    // A clock before the epoch means a broken VM, but emitting a wrong
    // timestamp into a durability record is worse than carrying four lines to
    // handle it: borrow a second so the fraction stays positive, the same
    // representation `Duration` uses going forward.
    let (secs, nanos) = match at.duration_since(UNIX_EPOCH) {
        Ok(since) => (since.as_secs() as i64, since.subsec_nanos()),
        Err(before) => {
            let ago = before.duration();
            match ago.subsec_nanos() {
                0 => (-(ago.as_secs() as i64), 0),
                frac => (-(ago.as_secs() as i64) - 1, 1_000_000_000 - frac),
            }
        }
    };

    let days = secs.div_euclid(86_400);
    let time_of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{nanos:09}Z",
        time_of_day / 3_600,
        (time_of_day % 3_600) / 60,
        time_of_day % 60,
    )
}

/// Days since 1970-01-01 to a proleptic Gregorian date.
///
/// Hinnant's `civil_from_days`: shifting the era to start in March puts the
/// leap day last, which is what lets the month-length sequence be arithmetic
/// instead of a table.
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let shifted = days + 719_468;
    let era = if shifted >= 0 {
        shifted
    } else {
        shifted - 146_096
    } / 146_097;
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_shifted = (5 * day_of_year + 2) / 153;
    let day = (day_of_year - (153 * month_shifted + 2) / 5 + 1) as u32;
    let month = if month_shifted < 10 {
        month_shifted + 3
    } else {
        month_shifted - 9
    } as u32;
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
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

    /// Vectors verified against an independent implementation rather than
    /// against this code: epoch, a leap day in a century that is a leap year
    /// and one that is not, a fraction that must keep its leading zeros, and a
    /// pre-epoch instant that has to borrow a second.
    #[test]
    fn rfc3339_matches_known_instants() {
        for (secs, nanos, expected) in [
            (0i64, 0u32, "1970-01-01T00:00:00.000000000Z"),
            (1_700_000_000, 123_456_789, "2023-11-14T22:13:20.123456789Z"),
            (1_709_164_800, 0, "2024-02-29T00:00:00.000000000Z"),
            (951_782_400, 1, "2000-02-29T00:00:00.000000001Z"),
            (
                253_402_300_799,
                999_999_999,
                "9999-12-31T23:59:59.999999999Z",
            ),
            (-1, 500_000_000, "1969-12-31T23:59:59.500000000Z"),
        ] {
            let at = if secs >= 0 {
                UNIX_EPOCH + std::time::Duration::new(secs as u64, nanos)
            } else {
                let ago = (-secs) as u64 - u64::from(nanos > 0);
                let frac = if nanos > 0 { 1_000_000_000 - nanos } else { 0 };
                UNIX_EPOCH - std::time::Duration::new(ago, frac)
            };
            assert_eq!(rfc3339_nanos(at), expected, "secs={secs} nanos={nanos}");
        }
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

    /// Whether the entry survives a crash needs fault injection to observe, so
    /// this covers what is observable: both ways the directory sync can fail must
    /// surface as errors rather than let the barrier report itself armed. Called
    /// directly because reaching it through `write_begin` is impossible — a parent
    /// that cannot be opened cannot be traversed either, so the log's own `open`
    /// fails first and the sync never runs.
    #[test]
    fn a_failed_directory_sync_is_reported() {
        for (log_path, why) in [
            ("/", "root has no parent to sync"),
            (
                "/nonexistent-boxlite-capture-dir/output.log",
                "an absent parent cannot be synced",
            ),
        ] {
            let capture = Capture::from_request(
                request("b3f1c0a4-7d2e-4a91-8c55-0e6f2ab41d90"),
                PathBuf::from(log_path),
            )
            .unwrap()
            .unwrap();

            let error = capture.sync_parent().expect_err(why);
            assert!(
                matches!(error, BoxliteError::Internal(_)),
                "{why}: {error:?}"
            );
        }
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
