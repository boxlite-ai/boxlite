use super::{BoxConfig, BoxImpl, BoxState, BoxStatus, StopCommit, StopReason};
use crate::litebox::archive::{CHECKPOINT_DIRNAME, GUEST_ROOTFS_FILENAME, VMSTATE_FILENAME};
use crate::litebox::config::ContainerRuntimeConfig;
use crate::runtime::id::BoxIDMint;
use crate::runtime::options::{BoxOptions, BoxliteOptions, RootfsSpec};
use crate::runtime::rt_impl::RuntimeImpl;
use crate::runtime::types::ContainerID;
use crate::vmm::VmmKind;
use chrono::Utc;
use std::fs;
use std::path::PathBuf;
use tempfile::TempDir;

fn staged_box(status: BoxStatus) -> (BoxImpl, PathBuf, TempDir) {
    let home = tempfile::tempdir().unwrap();
    let runtime = RuntimeImpl::new(BoxliteOptions {
        home_dir: home.path().to_path_buf(),
        image_registries: vec![],
        ..Default::default()
    })
    .unwrap();
    let id = BoxIDMint::mint();
    let config = BoxConfig {
        box_home: runtime.layout.boxes_dir().join(id.as_str()),
        id,
        name: None,
        created_at: Utc::now(),
        container: ContainerRuntimeConfig {
            id: ContainerID::new(),
        },
        options: BoxOptions {
            rootfs: RootfsSpec::Image("alpine:latest".into()),
            cmd: Some(vec!["/bin/true".into()]),
            detach: true,
            auto_delete: Some(0),
            ..Default::default()
        },
        engine_kind: VmmKind::Libkrun,
    };
    let checkpoint = config.box_home.join(CHECKPOINT_DIRNAME);
    fs::create_dir_all(&checkpoint).unwrap();
    fs::write(checkpoint.join(VMSTATE_FILENAME), b"vmstate").unwrap();
    fs::write(checkpoint.join(GUEST_ROOTFS_FILENAME), b"guest-rootfs").unwrap();

    let mut state = BoxState::new();
    state.status = status;
    state.pending_memory_restore = true;
    state.set_lock_id(runtime.lock_manager.allocate().unwrap());
    runtime.box_manager.add_box(&config, &state).unwrap();
    let token = runtime.shutdown_token.child_token();
    (
        BoxImpl::new(config, state, runtime, token),
        checkpoint,
        home,
    )
}

fn persisted_state(box_impl: &BoxImpl) -> BoxState {
    box_impl
        .runtime
        .box_manager
        .update_box(box_impl.id())
        .unwrap()
}

#[test]
fn finish_stop_clears_checkpoint_for_non_configured_boxes() {
    for (status, reason) in [
        (BoxStatus::Stopped, StopReason::Requested),
        (BoxStatus::Failed, StopReason::Requested),
        (
            BoxStatus::Running,
            StopReason::Exited {
                health_checked: false,
            },
        ),
    ] {
        let (box_impl, checkpoint, _home) = staged_box(status);
        assert!(matches!(
            box_impl.finish_stop(reason).unwrap(),
            StopCommit::Settled
        ));
        assert!(!box_impl.state.read().pending_memory_restore, "{status}");
        assert!(
            !persisted_state(&box_impl).pending_memory_restore,
            "{status}"
        );
        assert!(!checkpoint.exists(), "{status}");
    }
}

#[test]
fn finish_stop_preserves_configured_checkpoint() {
    let (box_impl, checkpoint, _home) = staged_box(BoxStatus::Configured);
    box_impl.finish_stop(StopReason::Requested).unwrap();
    let state = persisted_state(&box_impl);
    assert_eq!(state.status, BoxStatus::Configured);
    assert!(state.pending_memory_restore);
    assert!(box_impl.state.read().pending_memory_restore);
    assert!(checkpoint.join(VMSTATE_FILENAME).is_file());
    assert!(checkpoint.join(GUEST_ROOTFS_FILENAME).is_file());
}

#[test]
fn restore_finalization_sets_start_latch_and_reclaims_only_vmstate() {
    let (box_impl, checkpoint, _home) = staged_box(BoxStatus::Running);
    assert!(box_impl.container_start.get().is_none());
    box_impl.finish_checkpoint_restore();
    assert!(box_impl.container_start.get().is_some());
    assert!(!checkpoint.join(VMSTATE_FILENAME).exists());
    assert_eq!(
        fs::read(checkpoint.join(GUEST_ROOTFS_FILENAME)).unwrap(),
        b"guest-rootfs"
    );
}

#[test]
fn pending_restore_permits_implicit_boot_with_user_command() {
    let (box_impl, _, _home) = staged_box(BoxStatus::Configured);
    box_impl
        .ensure_usable_without_rerunning_main("exec")
        .unwrap();
    box_impl.state.write().pending_memory_restore = false;
    let error = box_impl
        .ensure_usable_without_rerunning_main("exec")
        .unwrap_err();
    assert!(
        error
            .to_string()
            .contains("starting the box would run its main command")
    );
}

#[tokio::test]
async fn init_failure_resyncs_after_cleanup_guard_persists_failed_state() {
    // Seed the persisted failure in case the build guard returns before cleanup.
    let (box_impl, checkpoint, _home) = staged_box(BoxStatus::Unknown);
    let mut persisted = persisted_state(&box_impl);
    persisted.status = BoxStatus::Failed;
    persisted.error_reason = Some("restore failed".into());
    persisted.pending_memory_restore = false;
    box_impl
        .runtime
        .box_manager
        .save_box(box_impl.id(), &persisted)
        .unwrap();

    assert!(matches!(
        box_impl.init_live_state(true).await,
        Err(crate::BoxliteError::Unsupported(_) | crate::BoxliteError::InvalidState(_))
    ));
    let persisted = persisted_state(&box_impl);
    let in_memory = box_impl.state.read();
    assert_eq!(persisted.status, BoxStatus::Failed);
    assert_eq!(in_memory.status, persisted.status);
    assert!(!in_memory.pending_memory_restore);
    assert_eq!(in_memory.error_reason, persisted.error_reason);
    assert!(box_impl.container_start.get().is_none());
    assert!(checkpoint.join(VMSTATE_FILENAME).is_file());
}
