use super::*;
use crate::pipeline::ExecutionMode;

pub(super) fn plan_shape_with_restore(
    status: BoxStatus,
    checkpoint_restore: bool,
) -> Vec<(ExecutionMode, Vec<String>)> {
    get_execution_plan(status, checkpoint_restore)
        .unwrap()
        .stages()
        .into_iter()
        .map(|stage| {
            (
                stage.execution,
                stage
                    .tasks
                    .into_iter()
                    .map(|task| task.name().to_string())
                    .collect(),
            )
        })
        .collect()
}

#[test]
fn checkpoint_restore_skips_cold_boot_and_guest_init() {
    let expected = vec![
        (
            ExecutionMode::Sequential,
            vec!["filesystem_setup".to_string()],
        ),
        (ExecutionMode::Sequential, vec!["vmm_spawn".to_string()]),
        (ExecutionMode::Sequential, vec!["guest_connect".to_string()]),
        (ExecutionMode::Sequential, vec!["port_publish".to_string()]),
    ];
    for status in [BoxStatus::Configured, BoxStatus::Stopped, BoxStatus::Failed] {
        assert_eq!(plan_shape_with_restore(status, true), expected);
    }
}

#[test]
fn first_failed_start_does_not_reuse_an_uninitialized_disk() {
    let home = tempfile::tempdir().unwrap();
    let disks = home.path().join("disks");
    std::fs::create_dir(&disks).unwrap();
    std::fs::write(
        disks.join(crate::disk::constants::filenames::CONTAINER_DISK),
        b"created before GuestInit",
    )
    .unwrap();
    let mut state = BoxState::new();
    state.mark_failed("before GuestInit");
    assert_eq!(
        BoxBuilder::resolve_init_flags(&state),
        (false, false, false)
    );
}

#[test]
fn restore_failure_after_vmm_spawn_consumes_checkpoint_and_reuses_disk_on_retry() {
    use crate::BoxIDMint;
    use crate::litebox::archive::{CHECKPOINT_DIRNAME, GUEST_ROOTFS_FILENAME, VMSTATE_FILENAME};
    use crate::litebox::config::ContainerRuntimeConfig;
    use crate::runtime::options::{BoxOptions, BoxliteOptions};
    use crate::runtime::types::ContainerID;
    use crate::vmm::controller::{VmmHandler, VmmMetrics};
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };

    struct DummyHandler(Arc<AtomicBool>);
    impl VmmHandler for DummyHandler {
        fn stop(&mut self) -> BoxliteResult<()> {
            self.0.store(true, Ordering::SeqCst);
            Ok(())
        }
        fn metrics(&self) -> BoxliteResult<VmmMetrics> {
            unreachable!("not used in CleanupGuard drop test")
        }
        fn is_running(&self) -> bool {
            !self.0.load(Ordering::SeqCst)
        }
        fn pid(&self) -> u32 {
            99999
        }
    }

    let home = tempfile::tempdir().unwrap();
    let runtime = crate::runtime::rt_impl::RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: home.path().join("runtime"),
        ..Default::default()
    })
    .unwrap();
    let id = BoxIDMint::mint();
    let layout = runtime.layout.box_layout(id.as_str(), false).unwrap();
    let box_home = layout.root().to_path_buf();
    let checkpoint_dir = box_home.join(CHECKPOINT_DIRNAME);
    let disks_dir = box_home.join("disks");
    std::fs::create_dir_all(&checkpoint_dir).unwrap();
    std::fs::create_dir_all(&disks_dir).unwrap();
    std::fs::write(checkpoint_dir.join(VMSTATE_FILENAME), b"vmstate").unwrap();
    std::fs::write(checkpoint_dir.join(GUEST_ROOTFS_FILENAME), b"rootfs").unwrap();
    std::fs::write(
        disks_dir.join(crate::disk::constants::filenames::CONTAINER_DISK),
        b"rw-disk",
    )
    .unwrap();

    let config = BoxConfig {
        id: id.clone(),
        name: None,
        created_at: chrono::Utc::now(),
        container: ContainerRuntimeConfig {
            id: ContainerID::new(),
        },
        options: BoxOptions::default(),
        engine_kind: crate::vmm::VmmKind::Libkrun,
        box_home: box_home.clone(),
    };
    let mut state = BoxState::new();
    state.pending_memory_restore = true;
    state.rootfs_initialized = true;
    state.set_lock_id(runtime.lock_manager.allocate().unwrap());
    runtime.box_manager.add_box(&config, &state).unwrap();

    let stopped = Arc::new(AtomicBool::new(false));
    {
        let mut guard = super::types::CleanupGuard::new(Arc::clone(&runtime), id.clone());
        guard.set_layout(layout);
        guard.set_handler(Box::new(DummyHandler(Arc::clone(&stopped))));
        guard.mark_checkpoint_restore_spawned();
        guard.set_last_error(&BoxliteError::Internal("port 8080 conflict".into()));
    }

    assert!(stopped.load(Ordering::SeqCst));
    assert!(
        !checkpoint_dir.exists(),
        "checkpoint dir must be deleted after post-VmmSpawnTask failure"
    );
    let (_, failed_state) = runtime.box_manager.box_by_id(&id).unwrap().unwrap();
    assert_eq!(failed_state.status, BoxStatus::Failed);
    assert!(
        !failed_state.pending_memory_restore,
        "pending_memory_restore must be false after VmmSpawnTask spawned VM"
    );

    let (reuse_rootfs, skip_guest_wait, checkpoint_restore) =
        BoxBuilder::resolve_init_flags(&failed_state);
    assert!(
        reuse_rootfs,
        "retrying a consumed checkpoint must reuse its initialized disk"
    );
    assert!(!skip_guest_wait);
    assert!(
        !checkpoint_restore,
        "retry must cold boot rather than replaying stale vmstate"
    );
}
