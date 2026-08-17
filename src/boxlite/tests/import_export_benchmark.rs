//! Manual import/export performance benchmark.
//!
//! Run only through `make test:perf:import-export`.

mod common;

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[cfg(target_os = "linux")]
use std::fs::OpenOptions;
#[cfg(target_os = "linux")]
use std::os::fd::AsRawFd;

use boxlite::runtime::options::{BoxliteOptions, ExportOptions};
use boxlite::runtime::types::BoxStatus;
use boxlite::{BoxCommand, BoxliteRuntime, LiteBox};
use tempfile::TempDir;

const BYTES_PER_MIB: f64 = 1024.0 * 1024.0;
const GIB: u64 = 1024 * 1024 * 1024;
const PAYLOAD_BYTES: u64 = GIB;
const MAX_FILE_SIZE_BYTES: u64 = 2 * GIB;
const DISK_SIZE_GB: u64 = 4;
const WARMUP_RUNS: usize = 1;
const SAMPLE_RUNS: usize = 3;
const PAYLOAD_PATH: &str = "/root/boxlite-import-export-perf.bin";

#[derive(Clone, Copy, PartialEq, Eq)]
enum CacheMode {
    ColdBestEffort,
    Warm,
}

impl CacheMode {
    fn label(self) -> &'static str {
        match self {
            Self::ColdBestEffort => "cold_best_effort",
            Self::Warm => "warm",
        }
    }

    fn evicts_input_files(self) -> bool {
        self == Self::ColdBestEffort
    }
}

struct Sample {
    iteration: usize,
    archive_bytes: u64,
    export_elapsed: Duration,
    import_elapsed: Duration,
    export_mib_per_sec: f64,
    import_mib_per_sec: f64,
}

struct ModeResult {
    warmups: Vec<Sample>,
    samples: Vec<Sample>,
    retained_import: Option<LiteBox>,
}

struct Statistics {
    min: f64,
    p50: f64,
    p95: f64,
    max: f64,
    mean: f64,
}

#[tokio::test]
#[ignore = "manual 1 GiB performance benchmark; run make test:perf:import-export"]
async fn test_import_export_1gib_benchmark() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create benchmark runtime");

    let source = create_benchmark_source(&runtime).await;
    let source_disk_files = find_source_disk_files(&home.path, &source)
        .expect("locate source disk files for cache eviction");
    let export_dir = TempDir::new_in("/tmp").expect("create benchmark export directory");

    eprintln!(
        "BENCHMARK_CONFIG payload_bytes={PAYLOAD_BYTES} disk_size_gb={DISK_SIZE_GB} \
         warmup_runs={WARMUP_RUNS} sample_runs={SAMPLE_RUNS} os={} arch={} release=true",
        std::env::consts::OS,
        std::env::consts::ARCH,
    );

    #[cfg(target_os = "linux")]
    match run_mode(
        &runtime,
        &source,
        &source_disk_files,
        export_dir.path(),
        CacheMode::ColdBestEffort,
        false,
    )
    .await
    {
        Ok(result) => print_mode_result(CacheMode::ColdBestEffort, &result),
        Err(error) => eprintln!(
            "BENCHMARK_SKIP mode={} reason={error}",
            CacheMode::ColdBestEffort.label()
        ),
    }

    #[cfg(not(target_os = "linux"))]
    eprintln!(
        "BENCHMARK_SKIP mode={} reason=file-level cache eviction is only supported on Linux",
        CacheMode::ColdBestEffort.label()
    );

    let warm_result = run_mode(
        &runtime,
        &source,
        &source_disk_files,
        export_dir.path(),
        CacheMode::Warm,
        true,
    )
    .await
    .expect("warm benchmark mode cannot fail cache eviction");
    print_mode_result(CacheMode::Warm, &warm_result);

    let imported = warm_result
        .retained_import
        .expect("warm benchmark must retain its final import for validation");
    validate_imported_payload(&imported).await;
    runtime
        .remove(imported.id().as_str(), false)
        .await
        .expect("remove validated imported box");
    runtime
        .remove(source.id().as_str(), false)
        .await
        .expect("remove benchmark source box");
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .expect("shut down benchmark runtime");
}

async fn create_benchmark_source(runtime: &BoxliteRuntime) -> LiteBox {
    let mut options = common::alpine_opts();
    options.disk_size_gb = Some(DISK_SIZE_GB);
    options.advanced.security.resource_limits.max_file_size = Some(MAX_FILE_SIZE_BYTES);

    let source = runtime
        .create(options, Some("import-export-perf-source".to_string()))
        .await
        .expect("create benchmark source box");
    source.start().await.expect("start benchmark source box");

    let write_result = async {
        let command = BoxCommand::new("sh").args([
            "-c",
            "dd if=/dev/urandom of=/root/boxlite-import-export-perf.bin \
             bs=1048576 count=1024 2>/dev/null && sync",
        ]);
        let execution = source.exec(command).await?;
        execution.wait().await
    }
    .await;

    let stop_result = source.stop().await;
    stop_result.expect("stop benchmark source box after payload creation");
    let result = write_result.expect("write 1 GiB benchmark payload");
    assert_eq!(
        result.exit_code, 0,
        "benchmark payload command must succeed"
    );
    assert_eq!(
        source
            .info()
            .await
            .expect("inspect benchmark source")
            .status,
        BoxStatus::Stopped
    );

    source
}

async fn run_mode(
    runtime: &BoxliteRuntime,
    source: &LiteBox,
    source_disk_files: &[PathBuf],
    export_dir: &Path,
    mode: CacheMode,
    retain_last_import: bool,
) -> io::Result<ModeResult> {
    let mut warmups = Vec::with_capacity(WARMUP_RUNS);
    let mut samples = Vec::with_capacity(SAMPLE_RUNS);
    let mut retained_import = None;

    for run_index in 0..(WARMUP_RUNS + SAMPLE_RUNS) {
        let is_warmup = run_index < WARMUP_RUNS;
        let iteration = if is_warmup {
            run_index + 1
        } else {
            run_index - WARMUP_RUNS + 1
        };
        let archive_path = export_dir.join(format!(
            "import-export-{}-{}.boxlite",
            mode.label(),
            run_index + 1
        ));

        if mode.evicts_input_files() {
            evict_file_caches(source_disk_files)?;
        }

        let export_started = Instant::now();
        let archive = source
            .export(ExportOptions::default(), &archive_path)
            .await
            .expect("export benchmark source");
        let export_elapsed = export_started.elapsed();
        let archive_bytes = fs::metadata(archive.path())
            .expect("read exported archive metadata")
            .len();

        if mode.evicts_input_files() {
            if let Err(error) = evict_file_cache(archive.path()) {
                let _ = fs::remove_file(archive.path());
                return Err(error);
            }
        }

        let archive_path = archive.path().to_path_buf();
        let import_started = Instant::now();
        let imported = runtime
            .import_box(
                archive,
                Some(format!(
                    "import-export-perf-{}-{}",
                    mode.label(),
                    run_index + 1
                )),
            )
            .await
            .expect("import benchmark archive");
        let import_elapsed = import_started.elapsed();

        assert_eq!(
            imported
                .info()
                .await
                .expect("inspect imported benchmark box")
                .status,
            BoxStatus::Stopped
        );

        let sample = Sample {
            iteration,
            archive_bytes,
            export_elapsed,
            import_elapsed,
            export_mib_per_sec: throughput_mib_per_sec(archive_bytes, export_elapsed),
            import_mib_per_sec: throughput_mib_per_sec(archive_bytes, import_elapsed),
        };

        let is_final_sample = !is_warmup && iteration == SAMPLE_RUNS;
        if retain_last_import && is_final_sample {
            retained_import = Some(imported);
        } else {
            runtime
                .remove(imported.id().as_str(), false)
                .await
                .expect("remove imported benchmark box");
        }
        fs::remove_file(&archive_path).expect("remove exported benchmark archive");

        if is_warmup {
            warmups.push(sample);
        } else {
            samples.push(sample);
        }
    }

    Ok(ModeResult {
        warmups,
        samples,
        retained_import,
    })
}

async fn validate_imported_payload(imported: &LiteBox) {
    imported
        .start()
        .await
        .expect("start final imported benchmark box");

    let validation_result = async {
        let command = BoxCommand::new("sh").args([
            "-c",
            "test \"$(wc -c < /root/boxlite-import-export-perf.bin)\" -eq 1073741824",
        ]);
        let execution = imported.exec(command).await?;
        execution.wait().await
    }
    .await;

    let stop_result = imported.stop().await;
    stop_result.expect("stop final imported benchmark box");
    let result = validation_result.expect("validate final imported payload size");
    assert_eq!(
        result.exit_code, 0,
        "imported payload must contain exactly {PAYLOAD_BYTES} bytes at {PAYLOAD_PATH}"
    );
}

fn find_source_disk_files(home: &Path, source: &LiteBox) -> io::Result<Vec<PathBuf>> {
    let disks_dir = home.join("boxes").join(source.id().as_str()).join("disks");
    let mut paths = Vec::new();

    for entry in fs::read_dir(&disks_dir)? {
        let entry = entry?;
        if entry.metadata()?.is_file() {
            paths.push(entry.path());
        }
    }
    paths.sort();

    if paths.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("no source disk files found in {}", disks_dir.display()),
        ));
    }

    Ok(paths)
}

fn evict_file_caches(paths: &[PathBuf]) -> io::Result<()> {
    for path in paths {
        evict_file_cache(path)?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn evict_file_cache(path: &Path) -> io::Result<()> {
    let file = OpenOptions::new().read(true).write(true).open(path)?;
    file.sync_all()?;

    // This is intentionally best-effort: POSIX_FADV_DONTNEED is a kernel hint,
    // not a guarantee that every backing page was evicted.
    // SAFETY: `file` owns a valid descriptor for the duration of the call;
    // offset and length zero ask the kernel to advise over the whole file and
    // do not expose any Rust memory to libc.
    let result = unsafe { libc::posix_fadvise(file.as_raw_fd(), 0, 0, libc::POSIX_FADV_DONTNEED) };
    if result != 0 {
        return Err(io::Error::new(
            io::Error::from_raw_os_error(result).kind(),
            format!(
                "failed to evict page cache for {}: {}",
                path.display(),
                io::Error::from_raw_os_error(result)
            ),
        ));
    }

    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn evict_file_cache(path: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        format!(
            "file-level cache eviction is unsupported on {} for {}",
            std::env::consts::OS,
            path.display()
        ),
    ))
}

fn throughput_mib_per_sec(bytes: u64, elapsed: Duration) -> f64 {
    bytes as f64 / BYTES_PER_MIB / elapsed.as_secs_f64()
}

fn print_mode_result(mode: CacheMode, result: &ModeResult) {
    for sample in &result.warmups {
        print_sample("BENCHMARK_WARMUP", mode, sample);
    }
    for sample in &result.samples {
        print_sample("BENCHMARK_SAMPLE", mode, sample);
    }

    print_statistics(
        mode,
        "export_latency_ms",
        &result
            .samples
            .iter()
            .map(|sample| sample.export_elapsed.as_secs_f64() * 1000.0)
            .collect::<Vec<_>>(),
    );
    print_statistics(
        mode,
        "import_latency_ms",
        &result
            .samples
            .iter()
            .map(|sample| sample.import_elapsed.as_secs_f64() * 1000.0)
            .collect::<Vec<_>>(),
    );
    print_statistics(
        mode,
        "export_archive_mib_per_sec",
        &result
            .samples
            .iter()
            .map(|sample| sample.export_mib_per_sec)
            .collect::<Vec<_>>(),
    );
    print_statistics(
        mode,
        "import_archive_mib_per_sec",
        &result
            .samples
            .iter()
            .map(|sample| sample.import_mib_per_sec)
            .collect::<Vec<_>>(),
    );
}

fn print_sample(prefix: &str, mode: CacheMode, sample: &Sample) {
    eprintln!(
        "{prefix} mode={} iteration={} archive_bytes={} export_ms={:.3} \
         export_mib_per_sec={:.3} import_ms={:.3} import_mib_per_sec={:.3}",
        mode.label(),
        sample.iteration,
        sample.archive_bytes,
        sample.export_elapsed.as_secs_f64() * 1000.0,
        sample.export_mib_per_sec,
        sample.import_elapsed.as_secs_f64() * 1000.0,
        sample.import_mib_per_sec,
    );
}

fn print_statistics(mode: CacheMode, metric: &str, values: &[f64]) {
    let statistics = statistics(values);
    eprintln!(
        "BENCHMARK_SUMMARY mode={} metric={metric} n={} min={:.3} p50={:.3} \
         p95={:.3} max={:.3} mean={:.3}",
        mode.label(),
        values.len(),
        statistics.min,
        statistics.p50,
        statistics.p95,
        statistics.max,
        statistics.mean,
    );
}

fn statistics(values: &[f64]) -> Statistics {
    assert!(!values.is_empty(), "statistics require at least one sample");
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);

    Statistics {
        min: sorted[0],
        p50: percentile(&sorted, 50.0),
        p95: percentile(&sorted, 95.0),
        max: sorted[sorted.len() - 1],
        mean: sorted.iter().sum::<f64>() / sorted.len() as f64,
    }
}

fn percentile(sorted: &[f64], percentile: f64) -> f64 {
    let rank = (sorted.len() - 1) as f64 * percentile / 100.0;
    let lower = rank.floor() as usize;
    let upper = rank.ceil() as usize;
    if lower == upper {
        return sorted[lower];
    }

    let upper_weight = rank - lower as f64;
    sorted[lower] * (1.0 - upper_weight) + sorted[upper] * upper_weight
}
