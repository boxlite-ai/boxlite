//! Integration tests: a torn COW rootfs overlay is discarded and rebuilt from
//! the image base on restart, so the box still boots — instead of failing
//! forever with `EBADMSG` on mount (#866).
//!
//! These reproduce the production incident: a host crash truncates a per-box
//! qcow2 overlay so its L1/L2 tables reference data clusters past the (now
//! shorter) end of the file. The qcow2 header and even the ext4 superblock can
//! still look intact, so a naive header check reuses the overlay; the guest
//! then reads a dangling cluster and the mount fails with
//! `EBADMSG: Not a data message`, looping on every restart.
//!
//! Verified two-sided on a real VM (Linux, root): on `main` the restart fails
//! with `Failed to mount /dev/vda ... EBADMSG`; with this fix the overlay is
//! detected as torn, discarded, rebuilt from the base, and the box boots.
//!
//! Requires a VM runtime (alpine:latest). Linux-only: the overlay-corruption
//! path is specific to the qcow2 + bwrap rootfs (macOS uses a different stack).

#![cfg(target_os = "linux")]

mod common;

use std::path::Path;

use boxlite::BoxliteRuntime;
use boxlite::litebox::BoxCommand;
use boxlite::runtime::options::BoxliteOptions;
use boxlite::runtime::types::BoxStatus;

/// Truncate a qcow2 overlay so it references clusters past the new EOF — the
/// host-crash-truncation corruption that makes a guest mount return `EBADMSG`.
///
/// Drops ~55% of the tail (keeping the header, L1, and early metadata) so that
/// referenced data/metadata clusters near the end dangle past the file end —
/// which is exactly what the production probe walks the L1/L2 tables to detect.
fn tear_overlay(path: &Path) {
    let size = std::fs::metadata(path)
        .unwrap_or_else(|e| panic!("stat overlay {}: {e}", path.display()))
        .len();
    // Keep at least the first 256 KiB (header + L1 + first L2/superblock cluster)
    // so the corruption is a dangling *referenced* cluster, not an unparseable
    // header.
    let leave = (size * 45 / 100).max(256 * 1024);
    assert!(
        leave < size,
        "overlay {} is too small to tear (size={size})",
        path.display()
    );
    let mut f = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .unwrap_or_else(|e| panic!("open overlay {}: {e}", path.display()));
    f.set_len(leave)
        .unwrap_or_else(|e| panic!("truncate overlay {}: {e}", path.display()));

    // The 45% cut is a heuristic: prove it actually severed a referenced cluster
    // (an L2 table or data cluster now past EOF), so a torn-overlay test can never
    // silently pass on an overlay that stayed reusable. This walks the L1/L2 tree
    // the same way the production probe does — replicated here because that probe
    // is `pub(crate)` and unreachable from this integration-test crate.
    assert_truncation_tore(&mut f, path, leave);
}

/// Fail unless truncating to `leave` left at least one L1-referenced L2 table or
/// L2-referenced data cluster whose end lies past the new EOF.
fn assert_truncation_tore(f: &mut std::fs::File, path: &Path, leave: u64) {
    use std::io::{Read, Seek, SeekFrom};
    const CLUSTER: u64 = 1 << 16; // qcow2 CLUSTER_BITS == 16
    const OFFSET_MASK: u64 = 0x00FF_FFFF_FFFF_FE00; // L1/L2 entry host-offset bits

    let dangles = |off: u64| off != 0 && off + CLUSTER > leave;

    let mut hdr = [0u8; 48];
    f.seek(SeekFrom::Start(0)).unwrap();
    f.read_exact(&mut hdr).unwrap();
    let l1_size = u64::from(u32::from_be_bytes(hdr[36..40].try_into().unwrap()));
    let l1_offset = u64::from_be_bytes(hdr[40..48].try_into().unwrap());
    assert!(
        l1_size > 0 && l1_offset != 0,
        "overlay {} has no L1 table to tear",
        path.display()
    );

    // The L1 table itself sliced off is already a definitive tear.
    if l1_offset + l1_size * 8 > leave {
        return;
    }
    f.seek(SeekFrom::Start(l1_offset)).unwrap();
    let mut l1 = vec![0u8; (l1_size * 8) as usize];
    f.read_exact(&mut l1).unwrap();
    for l1_entry in l1.chunks_exact(8) {
        let l2_off = u64::from_be_bytes(l1_entry.try_into().unwrap()) & OFFSET_MASK;
        if l2_off == 0 {
            continue;
        }
        if dangles(l2_off) {
            return; // L2 table now past EOF.
        }
        f.seek(SeekFrom::Start(l2_off)).unwrap();
        let mut l2 = vec![0u8; CLUSTER as usize];
        f.read_exact(&mut l2).unwrap();
        if l2
            .chunks_exact(8)
            .any(|e| dangles(u64::from_be_bytes(e.try_into().unwrap()) & OFFSET_MASK))
        {
            return; // a data cluster now past EOF.
        }
    }
    panic!(
        "tear_overlay({}) truncated to {leave} but left no referenced cluster past EOF — \
         the fixture would not exercise rebuild",
        path.display()
    );
}

/// `disk.qcow2` is the container rootfs (`/dev/vda`) — the overlay behind the
/// `Failed to mount /dev/vda ... EBADMSG` symptom this fix targets.
fn container_overlay(home: &Path, box_id: &str) -> std::path::PathBuf {
    home.join("boxes")
        .join(box_id)
        .join("disks")
        .join("disk.qcow2")
}

/// `guest-rootfs.qcow2` is the guest OS rootfs (`/dev/vdb`).
fn guest_overlay(home: &Path, box_id: &str) -> std::path::PathBuf {
    home.join("boxes")
        .join(box_id)
        .join("disks")
        .join("guest-rootfs.qcow2")
}

fn new_runtime(home: &Path) -> BoxliteRuntime {
    BoxliteRuntime::new(BoxliteOptions {
        home_dir: home.to_path_buf(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime")
}

/// Tearing the **container** overlay (`/dev/vda`) and restarting must discard +
/// rebuild it from the image base so the box boots — and the rebuild must wipe
/// the per-box writes (proving it booted on a fresh overlay, not the torn one).
#[tokio::test]
async fn torn_container_overlay_is_rebuilt_and_box_reboots() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = new_runtime(&home.path);

    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
    handle.start().await.expect("initial boot");
    let box_id = handle.id().to_string();

    // Churn filesystem metadata so the overlay allocates real clusters; the
    // clean stop then flushes the superblock / group descriptors into it.
    let exec = handle
        .exec(BoxCommand::new("sh").args([
            "-c",
            "for i in $(seq 1 200); do echo x > /root/f$i; done; sync",
        ]))
        .await
        .expect("metadata write exec");
    assert_eq!(exec.wait().await.expect("write").exit_code, 0);
    handle.stop().await.expect("clean stop");

    tear_overlay(&container_overlay(&home.path, &box_id));

    // Restart: the torn overlay must be detected, discarded, and rebuilt — not
    // looped on EBADMSG. (stop() invalidates the handle, so re-fetch it.)
    let handle = runtime.get(&box_id).await.unwrap().expect("recovered box");
    handle
        .start()
        .await
        .expect("box must boot after the torn container overlay is rebuilt from base");

    let info = runtime.get_info(&box_id).await.unwrap().unwrap();
    assert_eq!(
        info.status,
        BoxStatus::Running,
        "box should be Running after rebuild"
    );

    // The rebuild starts from the image base, so the pre-tear per-box files are
    // gone — confirming the box booted on a *fresh* overlay, not the torn one.
    let exec = handle
        .exec(BoxCommand::new("sh").args(["-c", "test ! -e /root/f1"]))
        .await
        .expect("post-rebuild exec");
    assert_eq!(
        exec.wait().await.expect("check").exit_code,
        0,
        "rebuilt overlay must not contain pre-tear per-box files"
    );

    handle.stop().await.ok();
    runtime.remove(&box_id, true).await.unwrap();
}

/// Same for the **guest** overlay (`/dev/vdb`): a torn guest rootfs overlay must
/// be discarded and rebuilt so the box boots.
#[tokio::test]
async fn torn_guest_overlay_is_rebuilt_and_box_reboots() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = new_runtime(&home.path);

    let handle = runtime.create(common::alpine_opts(), None).await.unwrap();
    handle.start().await.expect("initial boot");
    let box_id = handle.id().to_string();

    let exec = handle
        .exec(BoxCommand::new("sh").args(["-c", "sync"]))
        .await
        .expect("sync exec");
    assert_eq!(exec.wait().await.expect("sync").exit_code, 0);
    handle.stop().await.expect("clean stop");

    tear_overlay(&guest_overlay(&home.path, &box_id));

    let handle = runtime.get(&box_id).await.unwrap().expect("recovered box");
    handle
        .start()
        .await
        .expect("box must boot after the torn guest overlay is rebuilt from base");

    let info = runtime.get_info(&box_id).await.unwrap().unwrap();
    assert_eq!(
        info.status,
        BoxStatus::Running,
        "box should be Running after rebuild"
    );

    handle.stop().await.ok();
    runtime.remove(&box_id, true).await.unwrap();
}
