//! The box's main command: `BoxOptions.cmd` becomes the container's init
//! (docker `run` semantics), `attach()` streams it, and `BoxOptions.tty`
//! decides whether it gets a terminal.
//!
//! These exercise the paths the CLI's `run` takes, at the layer where a test
//! can actually reach them: `run -t` is rejected unless the CLI's own stdin is
//! a terminal, which it never is under a test harness.

mod common;

use boxlite::{BoxOptions, RootfsSpec};
use tokio_stream::StreamExt;

/// Create a box whose main command is `cmd`, optionally on a PTY.
fn main_command_opts(cmd: &[&str], tty: bool) -> BoxOptions {
    BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        auto_remove: false,
        cmd: Some(cmd.iter().map(|s| s.to_string()).collect()),
        tty,
        ..Default::default()
    }
}

/// Start a box, attach to its main command, and collect what it prints.
///
/// The command is expected to keep running after it speaks: attaching to a
/// process that already exited is a different scenario, and this helper is not
/// it.
async fn attached_stdout(opts: BoxOptions) -> String {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = boxlite::BoxliteRuntime::new(boxlite::runtime::options::BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let handle = runtime.create(opts, None).await.expect("create box");
    handle.start().await.expect("start box");

    let mut execution = handle.attach().await.expect("attach to the main command");

    let mut stdout = String::new();
    if let Some(mut stream) = execution.stdout() {
        // The command prints one line then sleeps, so take the first chunk that
        // carries our answer rather than waiting for an EOF that will not come
        // until the box is torn down.
        while let Some(chunk) = stream.next().await {
            stdout.push_str(&chunk);
            if stdout.contains("TTY") || stdout.contains("NOTTY") {
                break;
            }
        }
    }

    let _ = handle.stop().await;
    let _ = runtime.remove(handle.id().as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;

    stdout
}

/// `tty: true` must give the *main command* a real terminal.
///
/// `test -t 0` asks the kernel, so this cannot pass unless init's fd 0 really
/// is a tty: the guest has to set OCI `process.terminal`, receive the PTY
/// master over the console socket, and wire it to init's session.
///
/// This is the regression guard for `run -it`. Once COMMAND became init, it
/// stopped travelling the exec path that used to build its PTY, and init's
/// spec was hard-coded `terminal(false)` — so `-it` silently degraded to
/// pipes: no prompt, no job control, and every `test -t 0` inside the box
/// answering NOTTY.
#[tokio::test]
async fn main_command_gets_a_pty_when_tty_is_set() {
    let stdout = attached_stdout(main_command_opts(
        &["sh", "-c", "test -t 0 && echo TTY || echo NOTTY; sleep 30"],
        true,
    ))
    .await;

    assert!(
        stdout.contains("TTY") && !stdout.contains("NOTTY"),
        "init's stdin must be a terminal when tty is set, got: {stdout:?}"
    );
}

/// The control: without `tty`, the main command is on pipes, as before.
///
/// Without this the test above proves nothing — "TTY" could just be what the
/// box always says.
#[tokio::test]
async fn main_command_gets_pipes_when_tty_is_unset() {
    let stdout = attached_stdout(main_command_opts(
        &["sh", "-c", "test -t 0 && echo TTY || echo NOTTY; sleep 30"],
        false,
    ))
    .await;

    assert!(
        stdout.contains("NOTTY"),
        "init's stdin must be a pipe when tty is unset, got: {stdout:?}"
    );
}

/// A stopped box with **no** main command of its own must still wake up on
/// `exec`. This is the cloud's auto-stop contract and it is not optional.
///
/// The cloud reaps idle boxes on a cron, leaving them Stopped, and revives them
/// on the next SDK call — which goes straight to `/exec` and never calls start.
/// The guard that stops a *job* from re-running itself must therefore key on the
/// box's config, not merely on its status: a box without `cmd` boots the image's
/// own default (an agent daemon), and restarting that is the designed behaviour.
///
/// Gating on status alone silently repealed this. Nothing in `apps/` compensates:
/// the data-plane proxy forwards `/exec` and only bumps `lastActivityAt`.
#[tokio::test]
async fn a_stopped_box_without_a_main_command_still_restarts_on_exec() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = boxlite::BoxliteRuntime::new(boxlite::runtime::options::BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    // No `cmd`: init is the image default, exactly as a cloud box is created.
    let opts = BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        auto_remove: false,
        ..Default::default()
    };
    let handle = runtime.create(opts, None).await.expect("create box");
    handle.start().await.expect("start box");
    handle.stop().await.expect("stop box");

    // The reaper stopped it; the next SDK call must bring it back by itself.
    let fresh = runtime
        .get(handle.id().as_str())
        .await
        .expect("get box")
        .expect("box exists");
    drop(handle);

    let execution = fresh
        .exec(boxlite::BoxCommand::new("echo").args(vec!["awake".to_string()]))
        .await
        .expect("exec must implicitly restart a stopped box that has no main command");
    let result = execution.wait().await.expect("wait");
    assert_eq!(result.exit_code, 0, "the revived box must actually run it");

    let _ = fresh.stop().await;
    let _ = runtime.remove(fresh.id().as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

/// A retained handle whose VM has died must refuse, not hand back the corpse —
/// and this is the one box where nothing else would stop it.
///
/// The re-run gate deliberately *passes* a stopped box with no main command of
/// its own, because the cloud's auto-restart depends on exactly that. So for this
/// box, and only this box, `live_state()` is the last thing standing between the
/// caller and a dead VM: its `OnceCell` is already initialized, cannot be
/// re-initialized, and would hand back the `LiveState` of a guest that is gone —
/// the restart the caller was promised silently never happening.
///
/// Killing the shim is what a self-stop looks like from the host: the guest
/// powers the VM off and the shim dies. Reaching that state via an image whose
/// default exits would need a different image; killing the shim is the same
/// state, arrived at directly.
#[tokio::test]
async fn a_stopped_no_command_box_refuses_to_serve_its_dead_vm() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = boxlite::BoxliteRuntime::new(boxlite::runtime::options::BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    // No `cmd` and no `entrypoint`: the gate lets this box's exec through.
    let opts = BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        auto_remove: false,
        ..Default::default()
    };
    let handle = runtime.create(opts, None).await.expect("create box");
    handle.start().await.expect("start box");
    let shim = handle.info().pid.expect("a running box has a shim");

    // The VM dies underneath the handle.
    let killed = std::process::Command::new("kill")
        .args(["-9", &shim.to_string()])
        .status()
        .expect("run kill");
    assert!(killed.success(), "the shim must actually be killed");

    let mut status = handle.info().status;
    for _ in 0..60 {
        status = handle.info().status;
        if status != boxlite::BoxStatus::Running {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    assert_ne!(
        status,
        boxlite::BoxStatus::Running,
        "precondition: the box must be observed to have stopped"
    );

    // The gate passes this box (no main command), so the refusal must come from
    // live_state() — or the caller gets a corpse.
    let err = match handle.exec(boxlite::BoxCommand::new("echo")).await {
        Ok(_) => panic!("a spent handle must refuse, not hand back the dead VM"),
        Err(e) => e,
    };
    let msg = err.to_string();
    assert!(
        msg.contains("spent") || msg.contains("no longer running"),
        "the refusal must say the handle is spent, got: {msg}"
    );

    // And the box itself is fine — a fresh handle restarts it on exec, which is
    // the auto-restart the cloud relies on. The refusal is about the handle, not
    // the box.
    let box_id = handle.id().to_string();
    drop(handle);

    let fresh = runtime
        .get(&box_id)
        .await
        .expect("get box")
        .expect("box exists");
    let execution = fresh
        .exec(boxlite::BoxCommand::new("echo").args(vec!["awake".to_string()]))
        .await
        .expect("a fresh handle must restart the box and run the exec");
    let result = execution.wait().await.expect("wait");
    assert_eq!(result.exit_code, 0, "the revived box must actually run it");

    let _ = fresh.stop().await;
    let _ = runtime.remove(&box_id, true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

/// A failed `start_attached()` must not poison the handle into creating a
/// container it never runs.
///
/// The boot mode — "hold init at the gate, I will attach first" — used to live on
/// the handle as a flag. `get_or_try_init` leaves its cell empty when a boot
/// fails, and `Failed` is startable, so the flag outlived the call that meant it:
/// a later plain `start()` would re-enter the pipeline, still find it set, create
/// the container and never send `Container.Start`. The box would report Running
/// with a main command that never ran, and an attach would stream nothing,
/// forever. Passing the mode as a parameter is what makes that unrepresentable.
#[tokio::test]
async fn a_failed_attached_start_does_not_poison_the_next_start() {
    use std::os::unix::fs::PermissionsExt;

    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = boxlite::BoxliteRuntime::new(boxlite::runtime::options::BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    let handle = runtime
        .create(
            main_command_opts(&["sh", "-c", "sleep 30"], false),
            Some("poison".to_string()),
        )
        .await
        .expect("create box");

    // Fail the first boot *transiently*. That is the whole point: the same box and
    // the same handle must be startable afterwards. A permanent failure (a bad
    // image) could never expose a stranded flag, because the retry would fail for
    // the same reason and never reach the pipeline — which is exactly the hole a
    // reviewer caught in the first version of this test. Making the boxes
    // directory unwritable stops the box's own directory from being created, and
    // is undone immediately.
    let boxes_dir = home.path.join("boxes");
    std::fs::create_dir_all(&boxes_dir).expect("boxes dir");
    let restore = std::fs::metadata(&boxes_dir).expect("stat").permissions();
    let mut readonly = restore.clone();
    readonly.set_mode(0o500);
    std::fs::set_permissions(&boxes_dir, readonly).expect("make read-only");

    let failed = handle.start_attached().await;

    std::fs::set_permissions(&boxes_dir, restore).expect("restore permissions");
    assert!(
        failed.is_err(),
        "precondition: the boot must fail while the boxes directory is unwritable"
    );

    // Same box, same BoxImpl. A boot mode stranded on the handle would now create
    // the container and never send Container.Start: the box would come up Running
    // with a main command that never ran.
    handle
        .start()
        .await
        .expect("a plain start must boot normally after a failed attached start");

    // Proof that init actually *ran*, not merely got created: exec into it.
    // libcontainer refuses an exec against a container still in `Created`, which is
    // precisely what a stranded flag leaves behind.
    let execution = handle
        .exec(boxlite::BoxCommand::new("echo").args(vec!["ran".to_string()]))
        .await
        .expect("the box's init must be running, not merely created");
    let result = execution.wait().await.expect("wait");
    assert_eq!(
        result.exit_code, 0,
        "the started box must really be running"
    );

    let _ = handle.stop().await;
    let _ = runtime.remove(handle.id().as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

/// A box the runtime *adopts* — already running when this process found it —
/// must be followed to its exit too, not just one this process started.
///
/// The watcher used to be armed only by our own `start()`. But a long-lived
/// runtime meets already-running boxes on every restart: `boxlite serve` comes
/// back up, recovers them, and may never touch them again. Such a box would run
/// to completion entirely unobserved and be reported Running forever — which is
/// the exact lie the watcher exists to stop telling, told to precisely the
/// audience it was written for.
#[tokio::test]
async fn an_adopted_running_box_is_followed_to_its_exit() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let opts = || boxlite::runtime::options::BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    };

    // A first runtime starts a detached box, then goes away without stopping it.
    // `detach` is what lets the shim outlive its runtime.
    {
        let first = boxlite::BoxliteRuntime::new(opts()).expect("create runtime");
        let mut box_opts = main_command_opts(&["sh", "-c", "sleep 5; exit 9"], false);
        box_opts.detach = true;
        let handle = first
            .create(box_opts, Some("adopted".to_string()))
            .await
            .expect("create box");
        handle.start().await.expect("start box");
    }

    // A second runtime adopts it: `get()` hands out a handle, which is where the
    // watcher gets armed for a box we did not start.
    let second = boxlite::BoxliteRuntime::new(opts()).expect("create second runtime");
    let adopted = second
        .get("adopted")
        .await
        .expect("get box")
        .expect("box exists");
    assert_eq!(
        adopted.info().status,
        boxlite::BoxStatus::Running,
        "precondition: the box must still be running when we adopt it"
    );

    // Its main command now exits on its own. Nothing in this process started the
    // box, so only an armed watcher can notice.
    let mut info = adopted.info();
    for _ in 0..60 {
        info = adopted.info();
        if info.status != boxlite::BoxStatus::Running {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }

    assert_ne!(
        info.status,
        boxlite::BoxStatus::Running,
        "an adopted box's exit must be observed — otherwise it is reported Running forever"
    );
    assert_eq!(
        info.exit_code,
        Some(9),
        "and its exit code must be surfaced, not just its death"
    );

    let _ = second.remove(adopted.id().as_str(), true).await;
    let _ = second.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}

/// A box that stopped itself must never accept `start()` on the spent handle
/// and pretend it worked — and a fresh handle must be able to restart it.
///
/// Boxes can now end on their own: the main command exits, the guest powers the
/// VM off, and the exit watcher marks the box Stopped. That leaves the handle
/// holding a dead `LiveState` in a `OnceCell` that cannot be re-initialized, so
/// `start()` would sail past every guard — the token is uncancelled (only
/// `stop()` cancels it) and `Stopped` is startable — hand back the corpse, boot
/// nothing, and return Ok. A long-lived runtime would think it had restarted a
/// box that never came back.
#[tokio::test]
async fn a_self_stopped_box_refuses_to_restart_on_the_spent_handle() {
    let home = boxlite_test_utils::home::PerTestBoxHome::new();
    let runtime = boxlite::BoxliteRuntime::new(boxlite::runtime::options::BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: common::test_registries(),
    })
    .expect("create runtime");

    // A main command that exits on its own — the box stops itself.
    let handle = runtime
        .create(
            main_command_opts(&["sh", "-c", "exit 7"], false),
            Some("self-stop".to_string()),
        )
        .await
        .expect("create box");
    handle.start().await.expect("start box");

    // Wait for the watcher to observe the shim's death and record the exit.
    let mut info = handle.info();
    for _ in 0..60 {
        info = handle.info();
        if info.status != boxlite::BoxStatus::Running {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    assert_ne!(
        info.status,
        boxlite::BoxStatus::Running,
        "the box must stop itself once its main command exits"
    );
    assert_eq!(
        info.exit_code,
        Some(7),
        "the live watcher must surface the main command's exit code"
    );

    // The spent handle must refuse, not silently no-op.
    let err = handle
        .start()
        .await
        .expect_err("starting a spent handle must fail rather than boot nothing");
    let msg = err.to_string();
    assert!(
        msg.contains("spent") || msg.contains("fresh"),
        "the refusal must tell the caller to get a fresh handle, got: {msg}"
    );

    // And a fresh handle really does restart it — the refusal above is about
    // the handle, not the box. The runtime caches live handles behind Weak
    // refs, so the spent one must be dropped before `get()` will build a new
    // BoxImpl from persisted state; that is the same contract as after stop().
    drop(handle);
    let fresh = runtime
        .get("self-stop")
        .await
        .expect("get box")
        .expect("box exists");
    fresh.start().await.expect("a fresh handle must restart it");
    assert_eq!(
        fresh.info().status,
        boxlite::BoxStatus::Running,
        "the restarted box must actually be running"
    );

    let _ = fresh.stop().await;
    let _ = runtime.remove(fresh.id().as_str(), true).await;
    let _ = runtime.shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT)).await;
}
