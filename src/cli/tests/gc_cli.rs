//! Integration test for the `boxlite gc` CLI command. Covers the user-visible
//! surface that the unit tests in `src/boxlite/src/runtime/gc.rs` don't reach:
//! flag parsing (`--dry-run`), output format, exit code, and that the CLI
//! actually wires up the runtime's `collect_garbage` end-to-end.

use assert_cmd::Command;
use boxlite_test_utils::home::PerTestBoxHome;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

fn boxlite(home: &Path, args: &[&str], timeout: Duration) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_boxlite"))
        .arg("--home")
        .arg(home)
        .args(args)
        .timeout(timeout)
        .output()
        .expect("spawn boxlite")
}

fn disk_images_dir(home: &Path) -> PathBuf {
    home.join("images/disk-images")
}

/// All `*.ext4` regular files under `<home>/images/disk-images/`.
fn ext4_files(home: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(disk_images_dir(home)) else {
        return vec![];
    };
    entries
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().and_then(|e| e.to_str()) == Some("ext4"))
        .collect()
}

/// Set the file's mtime far enough in the past that GC's grace window (10 min)
/// is exceeded.
fn backdate_far(path: &Path) {
    let status = std::process::Command::new("touch")
        .args(["-t", "197001010000", path.to_str().expect("path is UTF-8")])
        .status()
        .expect("spawn touch");
    assert!(
        status.success(),
        "could not backdate {} via touch",
        path.display()
    );
}

/// Start one alpine box and remove it — the box's merged image disk-image is
/// left in `<home>/images/disk-images/` with no overlay backing it (an orphan).
fn create_an_orphan_disk_image(home: &Path) {
    let run = boxlite(
        home,
        &[
            "--registry",
            "docker.m.daocloud.io",
            "run",
            "-d",
            "--memory",
            "256",
            "alpine:latest",
            "sleep",
            "300",
        ],
        Duration::from_secs(300),
    );
    assert!(
        run.status.success(),
        "box start failed: {}",
        String::from_utf8_lossy(&run.stderr)
    );
    let box_id = String::from_utf8_lossy(&run.stdout).trim().to_string();
    let rm = boxlite(home, &["rm", "-f", &box_id], Duration::from_secs(30));
    assert!(
        rm.status.success(),
        "rm failed: {}",
        String::from_utf8_lossy(&rm.stderr)
    );
}

/// End-to-end coverage of the `boxlite gc` CLI: an aged-orphan `.ext4`
/// disk-image is reported in both `--dry-run` and real modes, the dry-run
/// preserves the file, and the real run actually deletes it. Both modes are
/// exercised against the SAME orphan in one box's worth of setup — keeps the
/// test cheap and side-steps any parallel-pull contention between two
/// separate tests racing the same registry / box runtime.
#[test]
fn gc_cli_dry_run_reports_then_real_run_reclaims() {
    let home = PerTestBoxHome::new();

    create_an_orphan_disk_image(home.path.as_path());
    let orphans = ext4_files(home.path.as_path());
    assert!(
        !orphans.is_empty(),
        "expected at least one orphan .ext4 in {} after box rm; got nothing",
        disk_images_dir(home.path.as_path()).display()
    );
    for o in &orphans {
        backdate_far(o);
    }

    // --- dry-run: report only, no deletion ----------------------------------
    let dry = boxlite(
        home.path.as_path(),
        &["gc", "--dry-run"],
        Duration::from_secs(60),
    );
    let dry_stdout = String::from_utf8_lossy(&dry.stdout);
    assert!(
        dry.status.success(),
        "boxlite gc --dry-run failed: {}",
        String::from_utf8_lossy(&dry.stderr)
    );
    assert!(
        dry_stdout.contains("Would reclaim") && dry_stdout.contains("dry run"),
        "gc --dry-run must report 'Would reclaim …' + 'dry run' marker; got = {dry_stdout:?}"
    );
    assert!(
        !dry_stdout.contains("0 orphan image disk"),
        "gc --dry-run must report a non-zero image-disk count; got = {dry_stdout:?}"
    );
    let after_dry = ext4_files(home.path.as_path());
    assert_eq!(
        after_dry.len(),
        orphans.len(),
        "dry run must not delete anything; before={} after={}",
        orphans.len(),
        after_dry.len()
    );

    // --- real run: report + actually delete ---------------------------------
    let real = boxlite(home.path.as_path(), &["gc"], Duration::from_secs(60));
    let real_stdout = String::from_utf8_lossy(&real.stdout);
    let real_stderr = String::from_utf8_lossy(&real.stderr);
    assert!(
        real.status.success(),
        "boxlite gc failed: stderr = {real_stderr}"
    );
    // Output form (src/cli/src/commands/gc.rs):
    //   "Reclaimed N.N MiB total (N orphan box dir(s), N orphan base(s), N orphan image disk(s))"
    assert!(
        real_stdout.contains("Reclaimed") && real_stdout.contains("orphan image disk"),
        "gc must report reclamation in the documented form; got = {real_stdout:?}"
    );
    assert!(
        !real_stdout.contains("0 orphan image disk"),
        "gc must report a non-zero image-disk count after dry-run + backdating; got = {real_stdout:?}"
    );

    let remaining = ext4_files(home.path.as_path());
    assert!(
        remaining.is_empty(),
        "all aged orphan .ext4 must be deleted by `boxlite gc`; remaining = {remaining:?}"
    );
}
