use super::*;

#[test]
fn checkpoint_operation_file_lock_conflicts_across_independent_processes() {
    if let Some(path) = std::env::var_os("BOXLITE_TEST_OPERATION_LOCK") {
        let error = Reservation::open(Path::new(&path))
            .err()
            .expect("parent owns the lock");
        assert!(error.to_string().contains("Busy"));
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("operation");
    File::create(&path).unwrap();
    let first = Reservation::open(&path).unwrap();
    assert!(
        Reservation::open(&path).is_err(),
        "independent descriptions conflict locally"
    );
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "litebox::operation::tests::checkpoint_operation_file_lock_conflicts_across_independent_processes"])
        .env("BOXLITE_TEST_OPERATION_LOCK", &path).status().unwrap();
    assert!(status.success());
    drop(first);
    assert!(Reservation::open(&path).is_ok());
    assert!(path.exists(), "lock inode survives guard release");
}

#[test]
fn checkpoint_operation_refusal_does_not_create_a_missing_lock() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("missing");
    assert!(Reservation::open(&path).is_err());
    assert!(!path.exists());
}

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
            (Action::DiskRestore, status == BoxStatus::Stopped),
        ] {
            let result = backend.reserve(action).await;
            assert_eq!(result.is_ok(), expected, "state={status}");
            drop(result);
        }
        assert!(
            !backend.layout.disks_dir().exists(),
            "reservation/refusal must not stage a disk"
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
    // The host reservation is deliberately absent: an independent control
    // client still owns the authoritative capture session.
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

#[tokio::test]
async fn checkpoint_operation_public_mutations_conflict_across_processes() {
    const ENV: &str = "BOXLITE_CHECKPOINT_OPERATION_HOME";
    if let Some(home) = std::env::var_os(ENV) {
        let runtime = crate::runtime::rt_impl::RuntimeImpl::new_for_test(crate::BoxliteOptions {
            home_dir: home.into(),
            ..Default::default()
        })
        .unwrap();
        let id = std::env::var("BOXLITE_CHECKPOINT_OPERATION_BOX").unwrap();
        let box_ = runtime.get(&id).await.unwrap().unwrap();
        let provider = crate::LocalCheckpointProvider::default();
        let destination = runtime.layout.home_dir().join("must-not-stage");
        let results = [
            box_.start().await,
            box_.pause(crate::PauseOptions::default()).await,
            box_.resume().await,
            box_.stop().await,
            runtime.remove(&id, true),
            box_.snapshots().remove("absent").await,
            box_.snapshots().restore("absent").await,
            box_.snapshots()
                .create(crate::SnapshotOptions::default(), "absent")
                .await
                .map(|_| ()),
            box_.clone_boxes(crate::CloneOptions::default(), 1, Vec::new())
                .await
                .map(|_| ()),
            box_.export_checkpoint(&destination, &provider).await,
        ];
        for (operation, result) in results.into_iter().enumerate() {
            let error = result.expect_err("parent owns the operation");
            assert!(
                error.to_string().contains("Busy"),
                "operation {operation}: {error}"
            );
        }
        assert!(!destination.exists());
        return;
    }
    let home = tempfile::tempdir_in("/tmp").unwrap();
    let runtime = crate::runtime::rt_impl::RuntimeImpl::new_for_test(crate::BoxliteOptions {
        home_dir: home.path().into(),
        ..Default::default()
    })
    .unwrap();
    let box_ = runtime
        .create(
            crate::BoxOptions {
                auto_delete: Some(0),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    let _held = Reservation::acquire(&runtime.layout, box_.id()).unwrap();
    let id = box_.id().clone();
    // Keep the independent operation description after the initiating runtime
    // releases its separate home lock, as a surviving copy supervisor does.
    drop(box_);
    drop(runtime);
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "litebox::operation::tests::checkpoint_operation_public_mutations_conflict_across_processes", "--nocapture"])
        .env(ENV, home.path()).env("BOXLITE_CHECKPOINT_OPERATION_BOX", id.as_str())
        .status().unwrap();
    assert!(
        status.success(),
        "cross-process public mutation client failed"
    );
}
