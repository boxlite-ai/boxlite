//! Boot timing instrumentation test (diagnostic, not run in CI).
//!
//! Reads shim.stderr after VM start to display the full boot timeline,
//! breaking the ~2.2s guest_connect wait into measurable sub-phases:
//! - Shim subprocess init (config parsing, gvproxy, engine FFI)
//! - VM kernel boot (irreducible libkrun/kernel time)
//! - Guest agent startup (tracing, tmpfs, gRPC bind, host notify)
//!
//! Run manually with:
//! ```sh
//! cargo test -p boxlite --test timing_profile -- --nocapture
//! ```

mod common;

use boxlite::BoxliteRuntime;
use boxlite::runtime::options::{BoxOptions, BoxliteOptions};
use std::time::Instant;

/// Print timing lines from shim.stderr, returning counts per prefix.
fn print_timing_lines(content: &str) -> (usize, usize, usize) {
    let mut shim_count = 0;
    let mut guest_count = 0;
    let mut krun_count = 0;

    for line in content.lines() {
        if line.starts_with("[shim]") {
            println!("{}", line);
            shim_count += 1;
        } else if line.starts_with("[guest]") {
            println!("{}", line);
            guest_count += 1;
        } else if line.starts_with("[krun]") {
            println!("{}", line);
            krun_count += 1;
        }
    }

    (shim_count, guest_count, krun_count)
}

#[tokio::test]
async fn boot_timing_profile() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
    let box_id = handle.id().clone();

    // Measure handle.start() — this includes the full guest_connect wait
    let start = Instant::now();
    handle.start().await.unwrap();
    let start_elapsed = start.elapsed();

    let stderr_path = home
        .path
        .join("boxes")
        .join(box_id.as_str())
        .join("shim.stderr");

    println!("\n============================================================");
    println!("  BOOT TIMING PROFILE");
    println!("============================================================");
    println!("handle.start() total: {:?}\n", start_elapsed);

    let console_log_path = home
        .path
        .join("boxes")
        .join(box_id.as_str())
        .join("logs")
        .join("console.log");

    // Read shim.stderr right after start (shim lines should be there)
    println!("--- shim.stderr (after start) ---");
    let (shim_count, guest_count, krun_count) = match std::fs::read_to_string(&stderr_path) {
        Ok(content) => print_timing_lines(&content),
        Err(e) => {
            println!(
                "Could not read shim.stderr at {}: {}",
                stderr_path.display(),
                e
            );
            (0, 0, 0)
        }
    };

    // Read console.log for guest-side kernel/init output
    println!("\n--- console.log (guest kernel + init) ---");
    match std::fs::read_to_string(&console_log_path) {
        Ok(content) => {
            let line_count = content.lines().count();
            for line in content.lines().take(80) {
                println!("  {}", line);
            }
            if line_count > 80 {
                println!("  ... ({} more lines)", line_count - 80);
            }
            println!("(total {} lines)", line_count);
        }
        Err(e) => {
            println!(
                "Could not read console.log at {}: {}",
                console_log_path.display(),
                e
            );
        }
    }

    // Print pipeline stage metrics from the handle
    println!("\n--- Pipeline Stage Metrics ---");
    if let Ok(metrics) = handle.metrics().await {
        println!(
            "  total_create_duration:   {:>6}ms",
            metrics.total_create_duration_ms.unwrap_or(0)
        );
        println!(
            "  stage_filesystem_setup:  {:>6}ms",
            metrics.stage_filesystem_setup_ms.unwrap_or(0)
        );
        println!(
            "  stage_image_prepare:     {:>6}ms",
            metrics.stage_image_prepare_ms.unwrap_or(0)
        );
        println!(
            "  stage_guest_rootfs:      {:>6}ms",
            metrics.stage_guest_rootfs_ms.unwrap_or(0)
        );
        println!(
            "  stage_box_spawn:         {:>6}ms",
            metrics.stage_box_spawn_ms.unwrap_or(0)
        );
        println!(
            "  stage_container_init:    {:>6}ms",
            metrics.stage_container_init_ms.unwrap_or(0)
        );
    }

    // Stop the box — this flushes VM buffers and may surface guest lines
    handle.stop().await.unwrap();

    // Re-read after stop to capture any guest output flushed during shutdown
    if guest_count == 0 {
        println!("\n--- shim.stderr (after stop, checking for guest lines) ---");
        if let Ok(content) = std::fs::read_to_string(&stderr_path) {
            let (_, guest_after, _) = print_timing_lines(&content);

            if guest_after == 0 {
                // Print full stderr for debugging
                println!("\n--- Full shim.stderr ({} bytes) ---", content.len());
                for line in content.lines().take(80) {
                    println!("  {}", line);
                }
                if content.lines().count() > 80 {
                    println!("  ... ({} more lines)", content.lines().count() - 80);
                }
            }
        }
    }

    println!("\n--- Summary ---");
    println!("Shim timing lines: {}", shim_count);
    println!("Guest timing lines (after start): {}", guest_count);
    println!("Krun timing lines: {}", krun_count);
    println!("============================================================\n");

    // Cleanup
    runtime.remove(box_id.as_str(), false).await.unwrap();
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

/// Same profile but with jailer disabled — isolates sandbox-exec overhead.
#[tokio::test]
async fn boot_timing_profile_no_jailer() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let opts = BoxOptions {
        rootfs: boxlite::runtime::options::RootfsSpec::Image("alpine:latest".into()),
        auto_remove: false,
        advanced: boxlite::AdvancedBoxOptions {
            security: boxlite::SecurityOptions {
                jailer_enabled: false,
                ..Default::default()
            },
            ..Default::default()
        },
        ..Default::default()
    };

    let handle = runtime.create(opts, None).await.unwrap();
    let box_id = handle.id().clone();

    let start = Instant::now();
    handle.start().await.unwrap();
    let start_elapsed = start.elapsed();

    let stderr_path = home
        .path
        .join("boxes")
        .join(box_id.as_str())
        .join("shim.stderr");

    println!("\n============================================================");
    println!("  BOOT TIMING PROFILE (NO JAILER)");
    println!("============================================================");
    println!("handle.start() total: {:?}\n", start_elapsed);

    println!("--- shim.stderr ---");
    if let Ok(content) = std::fs::read_to_string(&stderr_path) {
        print_timing_lines(&content);
    }

    if let Ok(metrics) = handle.metrics().await {
        println!("\n--- Pipeline Stage Metrics ---");
        println!(
            "  total_create_duration:   {:>6}ms",
            metrics.total_create_duration_ms.unwrap_or(0)
        );
        println!(
            "  stage_box_spawn:         {:>6}ms",
            metrics.stage_box_spawn_ms.unwrap_or(0)
        );
        println!(
            "  stage_container_init:    {:>6}ms",
            metrics.stage_container_init_ms.unwrap_or(0)
        );
    }
    println!("============================================================\n");

    handle.stop().await.unwrap();
    runtime.remove(box_id.as_str(), false).await.unwrap();
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}
