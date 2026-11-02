use super::*;

#[tokio::test]
async fn checkpoint_operation_state_matrix_refreshes_the_persisted_record() {
    use crate::vmm::checkpoint::{
        VmRunState,
        fake::{self, FakeOwner},
    };
    use crate::{BoxOptions, BoxliteOptions};
    let directory = tempfile::tempdir_in("/tmp").unwrap();
    let runtime = crate::runtime::rt_impl::RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: directory.path().into(),
        ..Default::default()
    })
    .unwrap();
    let litebox = runtime.create(BoxOptions::default(), None).await.unwrap();
    let backend = litebox.local_backend("test").unwrap();
    std::fs::create_dir_all(backend.layout.sockets_dir()).unwrap();
    backend.layout.sockets().ensure().unwrap();
    let owner = FakeOwner::new(VmRunState::Running);
    fake::serve(&backend.layout.control_socket_path(), owner.clone());
    for status in [
        BoxStatus::Configured,
        BoxStatus::Running,
        BoxStatus::Paused,
        BoxStatus::Stopped,
        BoxStatus::Stopping,
        BoxStatus::Failed,
    ] {
        let mut persisted = runtime.box_manager.update_box(litebox.id()).unwrap();
        persisted.force_status(status);
        persisted.start_mode =
            Some(crate::vmm::checkpoint::support::StartMode::Owner { protocol: 2 });
        runtime
            .box_manager
            .save_box(litebox.id(), &persisted)
            .unwrap();
        owner.set(match status {
            BoxStatus::Running => VmRunState::Running,
            BoxStatus::Paused => VmRunState::Paused,
            _ => VmRunState::Stopped,
        });
        for (action, expected) in [
            (
                Action::DiskCapture,
                matches!(status, BoxStatus::Running | BoxStatus::Stopped),
            ),
            (Action::Checkpoint, status == BoxStatus::Paused),
            (Action::Resize, status == BoxStatus::Running),
            (Action::DiskRestore, status == BoxStatus::Stopped),
        ] {
            let result = backend.check_operation(action).await;
            assert_eq!(result.is_ok(), expected, "state={status}");
        }
        assert!(
            !backend.layout.disks_dir().exists(),
            "state validation must not stage a disk"
        );
    }
}

#[tokio::test]
async fn checkpoint_snapshot_removal_conflicts_with_owner_capture() {
    use crate::vmm::checkpoint::{
        ControlClient, VmRunState,
        fake::{self, FakeOwner},
    };
    let home = tempfile::tempdir_in("/tmp").unwrap();
    let runtime = crate::runtime::rt_impl::RuntimeImpl::new_for_test(crate::BoxliteOptions {
        home_dir: home.path().into(),
        ..Default::default()
    })
    .unwrap();
    let litebox = runtime
        .create(crate::BoxOptions::default(), None)
        .await
        .unwrap();
    let backend = litebox.local_backend("test").unwrap();
    backend.layout.sockets().ensure().unwrap();
    std::fs::create_dir_all(backend.layout.sockets_dir()).unwrap();
    let owner = FakeOwner::new(VmRunState::Running);
    fake::serve(&backend.layout.control_socket_path(), owner);
    let mut state = runtime.box_manager.update_box(litebox.id()).unwrap();
    state.force_status(BoxStatus::Running);
    state.start_mode = Some(crate::vmm::checkpoint::support::StartMode::Owner { protocol: 2 });
    runtime.box_manager.save_box(litebox.id(), &state).unwrap();
    // An independent control client owns the authoritative capture session.
    let session = crate::litebox::checkpoint::capture::Session::begin(
        ControlClient::new(backend.layout.control_socket_path()),
        true,
    )
    .await
    .unwrap();
    let error = litebox.snapshots().remove("absent").await.unwrap_err();
    assert!(
        error.to_string().contains("Busy"),
        "must refuse before snapshot lookup: {error}"
    );
    session.finish().await.unwrap();
}
