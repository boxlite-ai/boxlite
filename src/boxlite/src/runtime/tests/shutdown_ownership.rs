use super::tests::{
    ChildGuard, create_test_runtime, running_state, spawn_dummy_process, test_box_config_in_layout,
    write_pid_file_with_fingerprint,
};
use super::*;
use crate::util::{PidRecord, is_process_alive, process_start_time};

struct RunningFixture {
    id: BoxID,
    pid: u32,
    lock_id: crate::lock::LockId,
    pid_file: std::path::PathBuf,
    _child: ChildGuard,
}

fn spawn_foreign_owner() -> (PidRecord, ChildGuard) {
    let (pid, child) = spawn_dummy_process();
    let owner = PidRecord {
        pid,
        start_time: process_start_time(pid),
    };
    (owner, ChildGuard(child))
}

fn dead_pid() -> u32 {
    let mut child = std::process::Command::new("true")
        .spawn()
        .expect("spawn short-lived process");
    let pid = child.id();
    let _ = child.wait();
    pid
}

fn allocate_box_locks(runtime: &RuntimeImpl, state: &mut BoxState) -> crate::lock::LockId {
    let lock_id = runtime.lock_manager.allocate().expect("allocate lock");
    runtime
        .disk_lock_manager
        .allocate_and_retrieve(lock_id)
        .unwrap();
    state.set_lock_id(lock_id);
    lock_id
}

fn add_running_box(
    runtime: &RuntimeImpl,
    detach: bool,
    owner: Option<PidRecord>,
    write_pid_file: bool,
) -> RunningFixture {
    let (pid, child) = spawn_dummy_process();
    let config = test_box_config_in_layout(detach, runtime);
    let mut state = BoxState::new();
    state.status = BoxStatus::Running;
    state.pid = Some(pid);
    state.owner = owner;
    let lock_id = allocate_box_locks(runtime, &mut state);

    let pid_file = runtime
        .layout
        .box_layout(config.id.as_str(), false)
        .expect("box_layout is infallible")
        .pid_file_path();
    if write_pid_file {
        write_pid_file_with_fingerprint(&pid_file, pid);
    }

    runtime.box_manager.add_box(&config, &state).unwrap();
    RunningFixture {
        id: config.id,
        pid,
        lock_id,
        pid_file,
        _child: ChildGuard(child),
    }
}

#[test]
fn test_shutdown_sync_skips_unowned_non_detached_box() {
    let (runtime, _dir) = create_test_runtime();
    let bx = add_running_box(&runtime, false, None, true);

    runtime.shutdown_sync();

    assert!(is_process_alive(bx.pid));
    assert!(bx.pid_file.exists());
    let (_, db_state) = runtime.box_manager.box_by_id(&bx.id).unwrap().unwrap();
    assert_eq!(db_state.status, BoxStatus::Running);
    assert_eq!(db_state.pid, Some(bx.pid));
}

#[tokio::test]
async fn test_drop_after_read_only_inspect_skips_unowned_non_detached_box() {
    let (runtime, dir) = create_test_runtime();
    let bx = add_running_box(&runtime, false, None, false);

    let info = runtime
        .get_info(bx.id.as_str())
        .await
        .unwrap()
        .expect("box exists");
    assert_eq!(info.status, BoxStatus::Running);

    drop(runtime);

    assert!(is_process_alive(bx.pid));
    let db = Database::open(&dir.path().join("db/boxlite.db")).unwrap();
    let persisted = BoxStore::new(db)
        .load_state(bx.id.as_str())
        .unwrap()
        .expect("box state exists");
    assert_eq!(persisted.status, BoxStatus::Running);
    assert_eq!(persisted.pid, Some(bx.pid));
}

#[tokio::test]
async fn test_shutdown_skips_adopted_unowned_non_detached_box() {
    let (runtime, _dir) = create_test_runtime();
    let bx = add_running_box(&runtime, false, None, true);

    let _adopted = runtime.get(bx.id.as_str()).await.unwrap().unwrap();
    runtime.shutdown(Some(2)).await.unwrap();

    assert!(is_process_alive(bx.pid));
    let (_, db_state) = runtime.box_manager.box_by_id(&bx.id).unwrap().unwrap();
    assert_eq!(db_state.status, BoxStatus::Running);
    assert_eq!(db_state.pid, Some(bx.pid));
}

#[test]
fn test_shutdown_sync_skips_non_matching_owners() {
    let (runtime, _dir) = create_test_runtime();
    let (foreign_owner, _foreign_guard) = spawn_foreign_owner();
    let current = PidRecord::current();

    let cases = [
        ("foreign process", foreign_owner),
        (
            "reused pid",
            PidRecord {
                pid: current.pid,
                start_time: Some(current.start_time.unwrap_or(0).wrapping_add(1)),
            },
        ),
        (
            "unverified start_time",
            PidRecord {
                pid: current.pid,
                start_time: None,
            },
        ),
    ]
    .map(|(label, owner)| {
        let bx = add_running_box(&runtime, false, Some(owner), false);
        (label, owner, bx)
    });

    runtime.shutdown_sync();

    for (label, expected_owner, bx) in cases {
        assert!(is_process_alive(bx.pid), "case: {label}");
        let (_, db_state) = runtime.box_manager.box_by_id(&bx.id).unwrap().unwrap();
        assert_eq!(db_state.status, BoxStatus::Running, "case: {label}");
        assert_eq!(db_state.pid, Some(bx.pid), "case: {label}");
        assert_eq!(db_state.owner, Some(expected_owner), "case: {label}");
    }
}

#[test]
fn test_shutdown_sync_stops_only_owned_non_detached_box() {
    let (runtime, _dir) = create_test_runtime();
    let (foreign_owner, _foreign_guard) = spawn_foreign_owner();
    let current = PidRecord::current();

    let owned = add_running_box(&runtime, false, Some(current), false);
    let foreign = add_running_box(&runtime, false, Some(foreign_owner), false);
    let unowned = add_running_box(&runtime, false, None, false);
    let detached = add_running_box(&runtime, true, Some(current), false);

    runtime.shutdown_sync();

    assert!(!is_process_alive(owned.pid));
    let (_, db_owned) = runtime.box_manager.box_by_id(&owned.id).unwrap().unwrap();
    assert_eq!(db_owned.status, BoxStatus::Stopped);
    assert!(db_owned.owner.is_none());

    for (label, bx) in [
        ("foreign", &foreign),
        ("unowned", &unowned),
        ("detached", &detached),
    ] {
        assert!(is_process_alive(bx.pid), "case: {label}");
        let (_, db_state) = runtime.box_manager.box_by_id(&bx.id).unwrap().unwrap();
        assert_eq!(db_state.status, BoxStatus::Running, "case: {label}");
    }
}

#[test]
fn test_shutdown_sync_ignores_busy_lock_on_foreign_box() {
    let (runtime, _dir) = create_test_runtime();
    let (foreign_owner, _foreign_guard) = spawn_foreign_owner();
    let bx = add_running_box(&runtime, false, Some(foreign_owner), false);

    let locker = runtime.lock_manager.retrieve(bx.lock_id).unwrap();
    let _busy_guard = LockGuard::new(locker.as_ref());

    runtime.shutdown_sync();

    assert!(!runtime.sync_cleanup_pending.load(Ordering::Acquire));
    assert!(is_process_alive(bx.pid));
    let (_, db_state) = runtime.box_manager.box_by_id(&bx.id).unwrap().unwrap();
    assert_eq!(db_state.status, BoxStatus::Running);
}

#[tokio::test]
async fn test_shutdown_rechecks_ownership_under_lifecycle_lock() {
    let (runtime, _dir) = create_test_runtime();
    let bx = add_running_box(&runtime, false, Some(PidRecord::current()), true);
    let _handle = runtime.get(bx.id.as_str()).await.unwrap().unwrap();

    // Hold the lifecycle lock while shutdown passes its pre-filter, then
    // transfer ownership in DB to another process before releasing it.
    let locker = runtime.lock_manager.retrieve(bx.lock_id).unwrap();
    let guard = LockGuard::new(locker.as_ref());

    let mut shutdown = Box::pin(runtime.shutdown(Some(2)));
    assert!(futures::poll!(&mut shutdown).is_pending());

    let (foreign_owner, _foreign_guard) = spawn_foreign_owner();
    let mut transferred = runtime.box_manager.update_box(&bx.id).unwrap();
    transferred.owner = Some(foreign_owner);
    runtime.box_manager.save_box(&bx.id, &transferred).unwrap();
    drop(guard);

    shutdown.await.unwrap();

    assert!(is_process_alive(bx.pid));
    let (_, db_state) = runtime.box_manager.box_by_id(&bx.id).unwrap().unwrap();
    assert_eq!(db_state.status, BoxStatus::Running);
    assert_eq!(db_state.owner, Some(foreign_owner));
}

#[tokio::test]
async fn test_shutdown_skips_box_removed_from_db_before_pre_filter() {
    let (runtime, _dir) = create_test_runtime();
    let config = test_box_config_in_layout(false, &runtime);
    let mut state = BoxState::new();
    state.status = BoxStatus::Stopped;
    allocate_box_locks(&runtime, &mut state);
    runtime.box_manager.add_box(&config, &state).unwrap();

    let _handle = runtime.get(config.id.as_str()).await.unwrap().unwrap();
    runtime.box_manager.remove_box(&config.id).unwrap();

    runtime.shutdown(Some(2)).await.unwrap();
}

#[test]
fn test_recovery_preserves_foreign_owner_and_clears_swapped_pid_owner() {
    let (runtime, dir) = create_test_runtime();
    let (foreign_owner, _foreign_guard) = spawn_foreign_owner();

    // Box 1: live shim matches persisted PID -> recovery preserves owner.
    let same = add_running_box(&runtime, false, Some(foreign_owner), true);

    // Box 2: live shim PID differs from persisted PID -> recovery adopts live PID and clears owner.
    let (pid_swapped, swapped_child) = spawn_dummy_process();
    let _swapped_child = ChildGuard(swapped_child);
    let config_swapped = test_box_config_in_layout(false, &runtime);
    let mut state_swapped = running_state(dead_pid());
    state_swapped.owner = Some(foreign_owner);
    allocate_box_locks(&runtime, &mut state_swapped);
    let pid_file_swapped = runtime
        .layout
        .box_layout(config_swapped.id.as_str(), false)
        .expect("box_layout is infallible")
        .pid_file_path();
    write_pid_file_with_fingerprint(&pid_file_swapped, pid_swapped);
    runtime
        .box_manager
        .add_box(&config_swapped, &state_swapped)
        .unwrap();

    drop(runtime);

    let recovered = RuntimeImpl::new_for_test(BoxliteOptions {
        home_dir: dir.path().to_path_buf(),
        ..Default::default()
    })
    .unwrap();

    let (_, recovered_same) = recovered.box_manager.box_by_id(&same.id).unwrap().unwrap();
    assert_eq!(recovered_same.status, BoxStatus::Running);
    assert_eq!(recovered_same.pid, Some(same.pid));
    assert_eq!(recovered_same.owner, Some(foreign_owner));

    let (_, recovered_swapped) = recovered
        .box_manager
        .box_by_id(&config_swapped.id)
        .unwrap()
        .unwrap();
    assert_eq!(recovered_swapped.status, BoxStatus::Running);
    assert_eq!(recovered_swapped.pid, Some(pid_swapped));
    assert!(recovered_swapped.owner.is_none());

    drop(recovered);
    assert!(is_process_alive(same.pid));
    assert!(is_process_alive(pid_swapped));
}
