#![cfg(any(
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "linux", target_arch = "x86_64")
))]

use super::tests::{StartGate, running_box_for_start_test};
use super::*;

#[tokio::test]
async fn checkpoint_staging_survives_stop_cleanup_and_cancelled_capture() {
    use crate::litebox::archive::{CHECKPOINT_DIRNAME, GUEST_ROOTFS_FILENAME};
    use crate::vmm::vmm_socket::{self, ControlOp, ControlReply};

    let gate = Arc::new(StartGate::default());
    gate.release.add_permits(1);
    let fixture = running_box_for_start_test(Arc::clone(&gate)).await;
    let bx = &fixture.box_impl;
    let mut state = bx.state.read().clone();
    state.set_pid(Some(std::process::id()));
    bx.runtime.box_manager.save_box(bx.id(), &state).unwrap();
    *bx.state.write() = state;

    let rootfs = bx
        .layout
        .root()
        .join(CHECKPOINT_DIRNAME)
        .join(GUEST_ROOTFS_FILENAME);
    std::fs::create_dir_all(rootfs.parent().unwrap()).unwrap();
    std::fs::write(&rootfs, b"guest disk").unwrap();
    std::fs::create_dir_all(bx.layout.sockets_dir()).unwrap();
    bx.layout.sockets().ensure().unwrap();

    let (entered, mut capture_started) = tokio::sync::mpsc::unbounded_channel();
    let (release, wait) = std::sync::mpsc::channel();
    let (written, mut completed) = tokio::sync::mpsc::unbounded_channel();
    let guest_rootfs_path = rootfs.clone();
    vmm_socket::serve(&bx.layout.sockets().vmm_sock(), move |op, _| {
        let ControlOp::CaptureCheckpoint {
            vm_state_path,
            disk_dst_path,
        } = op
        else {
            panic!("expected checkpoint capture");
        };
        entered
            .send(vm_state_path.parent().unwrap().to_path_buf())
            .unwrap();
        wait.recv_timeout(Duration::from_secs(5)).unwrap();
        let result = std::fs::write(vm_state_path, b"state")
            .and_then(|()| std::fs::write(disk_dst_path, b"disk"));
        written.send(result).unwrap();
        Ok(ControlReply::CheckpointCaptured {
            vm_state_bytes: 5,
            guest_rootfs_path: Some(guest_rootfs_path.clone()),
        })
    })
    .unwrap();

    for cancel in [false, true] {
        let bx = Arc::clone(bx);
        let capture = tokio::spawn(async move { bx.capture_full_checkpoint_to_dir().await });
        let staging = tokio::time::timeout(Duration::from_secs(5), capture_started.recv())
            .await
            .unwrap()
            .unwrap();
        if cancel {
            capture.abort();
            assert!(capture.await.err().unwrap().is_cancelled());
            assert!(staging.is_dir(), "the shim is still writing into staging");
            release.send(()).unwrap();
            completed.recv().await.unwrap().unwrap();
        } else {
            release.send(()).unwrap();
            completed.recv().await.unwrap().unwrap();
            let captured = capture.await.unwrap().unwrap();
            std::fs::remove_file(&rootfs).unwrap();
            assert_eq!(
                std::fs::read(&captured.guest_rootfs_path).unwrap(),
                b"guest disk"
            );
        }
    }
    assert_eq!(gate.calls.load(Ordering::SeqCst), 1);
}
