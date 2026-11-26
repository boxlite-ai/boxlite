//! OpenSpec PR-3 acceptance on Linux x86_64 KVM.
//! Run with `BOXLITE_TEST_ENGINE=native make test:integration:vmm:m2:run MATRIX_TEST_SUITES=runtime_mounts`.

#![cfg(all(feature = "native", target_os = "linux", target_arch = "x86_64"))]

mod common;

use boxlite::runtime::options::{BoxOptions, BoxliteOptions, MountSpec, NetworkSpec, VolumeSpec};
use boxlite::{
    BoxCommand, BoxStatus, BoxliteError, Execution, LiteBox, MountInfo, MountRequest, MountState,
};
use common::home::PerTestBoxHome;
use futures::{FutureExt, StreamExt};
use std::path::Path;
use std::time::Duration;

const READER: &str = "BOXLITE_TEST_MOUNT_READER";

fn source(probe: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir_in("/tmp").unwrap();
    std::fs::write(dir.path().join("probe"), probe).unwrap();
    dir
}

fn request(source: &Path, target: &str, read_only: bool) -> MountRequest {
    MountRequest {
        source: source.into(),
        target: target.into(),
        read_only,
    }
}

fn options() -> BoxOptions {
    BoxOptions {
        network: NetworkSpec::Disabled,
        cmd: Some(vec![
            "sh".into(),
            "-c".into(),
            "probe=$(cat /work/probe 2>/dev/null || echo absent); \
             printf '%s\\n' \"$probe\" >> /first-process; exec sleep 300"
                .into(),
        ]),
        ..common::alpine_opts()
    }
}

fn open(home: &Path) -> common::TestRuntime {
    common::TestRuntime::new(BoxliteOptions {
        home_dir: home.into(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .unwrap()
}

struct Lab {
    runtime: Option<common::TestRuntime>,
    home: PerTestBoxHome,
    boxes: Vec<String>,
}

impl Lab {
    fn runtime(&self) -> &common::TestRuntime {
        self.runtime.as_ref().unwrap()
    }

    async fn create(&mut self, options: BoxOptions) -> LiteBox {
        let bx = self.runtime().create(options, None).await.unwrap();
        self.boxes.push(bx.id().to_string());
        bx
    }

    async fn handle(&self, id: &str) -> LiteBox {
        self.runtime().get(id).await.unwrap().unwrap()
    }

    async fn release(&mut self) {
        self.runtime
            .take()
            .unwrap()
            .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
            .await
            .unwrap();
    }
}

async fn scenario(scene: impl AsyncFnOnce(&mut Lab)) {
    assert_eq!(
        std::env::var("BOXLITE_TEST_ENGINE").as_deref(),
        Ok("native")
    );
    let home = PerTestBoxHome::new();
    let mut lab = Lab {
        runtime: Some(open(&home.path)),
        home,
        boxes: Vec::new(),
    };
    let outcome = std::panic::AssertUnwindSafe(scene(&mut lab))
        .catch_unwind()
        .await;
    if lab.runtime.is_none() {
        lab.runtime = Some(open(&lab.home.path));
    }
    for id in &lab.boxes {
        lab.runtime().remove(id, true).await.unwrap();
    }
    if let Err(panic) = outcome {
        std::panic::resume_unwind(panic);
    }
}

async fn run(bx: &LiteBox, script: &str) -> (i32, String) {
    tokio::time::timeout(Duration::from_secs(60), async {
        let mut execution = bx
            .exec(BoxCommand::new("sh").args(["-c", script]))
            .await
            .unwrap();
        let mut output = String::new();
        if let Some(mut stream) = execution.stdout() {
            while let Some(chunk) = stream.next().await {
                output.push_str(&chunk);
            }
        }
        (execution.wait().await.unwrap().exit_code, output)
    })
    .await
    .unwrap_or_else(|_| panic!("command timed out: {script}"))
}

async fn demand(bx: &LiteBox, script: &str) {
    let (code, output) = run(bx, script).await;
    assert_eq!(code, 0, "{script}: {output}");
}

async fn wait_for(bx: &LiteBox, script: &str) {
    tokio::time::timeout(Duration::from_secs(10), async {
        while run(bx, script).await.0 != 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("condition timed out: {script}"));
}

async fn first_process(bx: &LiteBox, start: usize, expected: &str) {
    wait_for(
        bx,
        &format!("test $(grep -c '' /first-process) -ge {start}"),
    )
    .await;
    assert_eq!(
        run(bx, &format!("sed -n '{start}p' /first-process")).await,
        (0, format!("{expected}\n"))
    );
}

// Open both references before removal; release them only after the replacement is visible.
async fn hold(bx: &LiteBox) -> Execution {
    let held = bx
        .exec(BoxCommand::new("sh").args([
            "-c",
            "exec 3</work/probe; exec 4</work; touch /tmp/held-ready; \
         while [ ! -e /tmp/held-go ]; do sleep 0.02; done; \
         cat <&3 > /tmp/held-file; cat /proc/self/fd/4/probe > /tmp/held-dir",
        ]))
        .await
        .unwrap();
    wait_for(bx, "test -e /tmp/held-ready").await;
    held
}

async fn release(bx: &LiteBox, held: Execution, probe: &str) {
    demand(bx, "touch /tmp/held-go").await;
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(60), held.wait())
            .await
            .unwrap()
            .unwrap()
            .exit_code,
        0
    );
    assert_eq!(
        run(bx, "cat /tmp/held-file /tmp/held-dir").await,
        (0, probe.repeat(2))
    );
}

// Fail only the final live commit, after real guest and shim effects.
struct CommitAbort(rusqlite::Connection);

impl CommitAbort {
    fn arm(home: &Path, id: &str, adding: bool) -> Self {
        let conn = rusqlite::Connection::open(home.join("db/boxlite.db")).unwrap();
        conn.busy_timeout(Duration::from_secs(5)).unwrap();
        let condition = if adding {
            r#"OLD.json -> '$.mounts.changes."/work"' IS NULL AND NEW.json -> '$.mounts.changes."/work"' IS NOT NULL"#
        } else {
            r#"OLD.json -> '$.mounts.run.targets."/work"' IS NOT NULL AND NEW.json -> '$.mounts.run.targets."/work"' IS NULL"#
        };
        conn.execute_batch(&format!(
            "CREATE TRIGGER test_abort_mount_commit BEFORE UPDATE ON box_state \
             WHEN OLD.id = '{}' AND NEW.pid IS NOT NULL AND {condition} \
             BEGIN SELECT RAISE(ABORT, 'mount commit interrupted'); END",
            id.replace('\'', "''")
        ))
        .unwrap();
        Self(conn)
    }
}

impl Drop for CommitAbort {
    fn drop(&mut self) {
        self.0
            .execute_batch("DROP TRIGGER test_abort_mount_commit")
            .unwrap();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 1)]
#[ignore = "requires native runtime, KVM and VMM_KERNEL"]
async fn live_mounts_keep_lazy_references_and_support_remount() {
    scenario(async |lab| {
        let (data, replacement) = (source("original"), source("replacement"));
        let bx = lab.create(options()).await;
        bx.start().await.unwrap();
        let mounts = bx.mount();
        let (added, command) = tokio::join!(
            mounts.add(request(data.path(), "/work", false)),
            run(&bx, "echo alive")
        );
        let added = added.unwrap();
        assert_eq!(added.state, MountState::Mounted);
        assert_eq!(command, (0, "alive\n".into()));
        assert_eq!(
            mounts.list().await.unwrap().as_slice(),
            std::slice::from_ref(&added)
        );
        assert_eq!(mounts.get("/work").await.unwrap(), Some(added));
        assert!(mounts.get("/missing").await.unwrap().is_none());
        demand(&bx, "printf guest > /work/from-guest").await;
        assert_eq!(
            std::fs::read_to_string(data.path().join("from-guest")).unwrap(),
            "guest"
        );
        let held = hold(&bx).await;
        mounts.remove("/work").await.unwrap();
        demand(&bx, "test ! -e /work/probe").await;
        assert!(mounts.get("/work").await.unwrap().is_none());
        assert!(matches!(
            mounts.remove("/work").await,
            Err(BoxliteError::NotFound(_))
        ));
        mounts
            .add(request(replacement.path(), "/work", true))
            .await
            .unwrap();
        assert_eq!(run(&bx, "cat /work/probe").await, (0, "replacement".into()));
        assert_ne!(run(&bx, "touch /work/denied").await.0, 0);
        release(&bx, held, "original").await;
        bx.stop().await.unwrap();
    })
    .await;
}

#[tokio::test]
#[ignore = "requires native runtime, KVM and VMM_KERNEL"]
async fn creation_formats_deliver_once_and_remove_persistently() {
    scenario(async |lab| {
        let data = source("creation");
        for typed in [false, true] {
            let mut opts = options();
            if typed {
                let mut mount = MountSpec::bind_mount(data.path().to_str().unwrap(), "/work");
                mount.read_only = true;
                opts.mounts.push(mount);
            } else {
                let mut volume = VolumeSpec::bind_mount(data.path().to_str().unwrap(), "/work");
                volume.read_only = true;
                opts.volumes.push(volume);
            }
            let bx = lab.create(opts).await;
            assert_eq!(
                bx.mount().get("/work").await.unwrap().unwrap().state,
                MountState::Configured
            );
            bx.start().await.unwrap();
            first_process(&bx, 1, "creation").await;
            assert_eq!(
                run(
                    &bx,
                    "awk '$5 == \"/work\" { n++ } END { print n }' /proc/self/mountinfo"
                )
                .await,
                (0, "1\n".into())
            );
            assert_ne!(run(&bx, "touch /work/denied").await.0, 0);
            bx.mount().remove("/work").await.unwrap();
            bx.stop().await.unwrap();
            let next = lab.handle(bx.id().as_str()).await;
            next.start().await.unwrap();
            first_process(&next, 2, "absent").await;
            assert!(next.mount().get("/work").await.unwrap().is_none());
            next.stop().await.unwrap();
        }
    })
    .await;
}

#[tokio::test]
#[ignore = "requires native runtime, KVM and VMM_KERNEL"]
async fn offline_declarations_are_read_by_another_process_and_restarted() {
    if let Ok(ask) = std::env::var(READER) {
        let (home, id, expected): (std::path::PathBuf, String, MountInfo) =
            serde_json::from_str(&ask).unwrap();
        let runtime = open(&home);
        let bx = runtime.get(&id).await.unwrap().unwrap();
        assert_eq!(
            bx.mount().get("/work").await.unwrap(),
            Some(expected.clone())
        );
        assert_eq!(bx.mount().list().await.unwrap(), [expected]);
        std::process::exit(23); // Proves the child reached the assertions, rather than matching zero tests.
    }
    scenario(async |lab| {
        let (data, late) = (source("offline"), source("late"));
        let (id, saved) = {
            let bx = lab.create(options()).await;
            let saved = bx
                .mount()
                .add(request(data.path(), "/work", true))
                .await
                .unwrap();
            assert_eq!(saved.state, MountState::Configured);
            let state = bx.info().await.unwrap();
            assert_eq!((state.status, state.pid), (BoxStatus::Configured, None));
            (bx.id().to_string(), saved)
        };
        lab.release().await;
        let ask = serde_json::to_string(&(&lab.home.path, &id, saved)).unwrap();
        let child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "offline_declarations_are_read_by_another_process_and_restarted",
                "--ignored",
            ])
            .env(READER, ask)
            .kill_on_drop(true)
            .output();
        let child = tokio::time::timeout(Duration::from_secs(120), child)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            child.status.code(),
            Some(23),
            "{}{}",
            String::from_utf8_lossy(&child.stdout),
            String::from_utf8_lossy(&child.stderr)
        );
        lab.runtime = Some(open(&lab.home.path));
        let bx = lab.handle(&id).await;
        bx.start().await.unwrap();
        first_process(&bx, 1, "offline").await;
        let old = bx.mount();
        old.add(request(late.path(), "/late", false)).await.unwrap();
        bx.stop().await.unwrap();
        let next = lab.handle(&id).await;
        next.start().await.unwrap();
        first_process(&next, 2, "offline").await;
        assert_eq!(run(&next, "cat /late/probe").await, (0, "late".into()));
        assert!(matches!(
            old.remove("/work").await,
            Err(BoxliteError::Stopped(_))
        ));
        let held = hold(&next).await;
        next.mount().remove("/work").await.unwrap();
        release(&next, held, "offline").await;
        next.mount().remove("/late").await.unwrap();
        next.stop().await.unwrap();
        let last = lab.handle(&id).await;
        last.start().await.unwrap();
        first_process(&last, 3, "absent").await;
        demand(&last, "test ! -e /late/probe").await;
        last.stop().await.unwrap();
    })
    .await;
}

#[tokio::test]
#[ignore = "requires native runtime, KVM and VMM_KERNEL"]
async fn failed_boots_name_the_target_and_allow_offline_repair() {
    scenario(async |lab| {
        let data = source("data");
        let gone = data.path().join("gone");
        std::fs::create_dir(&gone).unwrap();
        let bx = lab.create(options()).await;
        bx.mount().add(request(&gone, "/work", false)).await.unwrap();
        std::fs::remove_dir(&gone).unwrap();
        assert!(bx.start().await.unwrap_err().to_string().contains("/work"));
        let bx = lab.handle(bx.id().as_str()).await;
        assert!(bx.info().await.unwrap().pid.is_none());
        bx.mount().remove("/work").await.unwrap();
        bx.start().await.unwrap();
        demand(&bx, "mkdir -p /work /mnt/behind; printf kept > /work/occupied; ln -s /mnt/behind /mnt/link").await;
        bx.stop().await.unwrap();
        for target in ["/work", "/mnt/link"] {
            let idle = lab.handle(bx.id().as_str()).await;
            idle.mount().add(request(data.path(), target, false)).await.unwrap();
            assert!(idle.start().await.unwrap_err().to_string().contains(target));
            let repair = lab.handle(bx.id().as_str()).await;
            assert!(repair.info().await.unwrap().pid.is_none());
            repair.mount().remove(target).await.unwrap();
        }
        let repaired = lab.handle(bx.id().as_str()).await;
        repaired.start().await.unwrap();
        demand(&repaired, "test \"$(cat /work/occupied)\" = kept; test -L /mnt/link; test -z \"$(ls -A /mnt/behind)\"").await;
        repaired.stop().await.unwrap();
    }).await;
}

#[tokio::test]
#[ignore = "requires native runtime, KVM and VMM_KERNEL"]
async fn interrupted_and_committed_changes_choose_the_next_boot() {
    scenario(async |lab| {
        let data = source("recovered");
        for adding in [true, false] {
            let bx = lab.create(options()).await;
            bx.start().await.unwrap();
            if !adding {
                bx.mount()
                    .add(request(data.path(), "/work", false))
                    .await
                    .unwrap();
            }
            let abort = CommitAbort::arm(&lab.home.path, bx.id().as_str(), adding);
            let result = if adding {
                bx.mount()
                    .add(request(data.path(), "/work", false))
                    .await
                    .map(|_| ())
            } else {
                bx.mount().remove("/work").await
            };
            let error = result.unwrap_err();
            assert!(
                matches!(error, BoxliteError::Database(_))
                    && error.to_string().contains("mount commit interrupted"),
                "{error}"
            );
            drop(abort);
            bx.stop().await.unwrap();
            let next = lab.handle(bx.id().as_str()).await;
            assert_eq!(
                next.mount()
                    .get("/work")
                    .await
                    .unwrap()
                    .map(|entry| entry.state),
                (!adding).then_some(MountState::Configured)
            );
            next.start().await.unwrap();
            first_process(&next, 2, if adding { "absent" } else { "recovered" }).await;
            if adding {
                next.mount()
                    .add(request(data.path(), "/work", false))
                    .await
                    .unwrap();
            }
            assert_eq!(run(&next, "cat /work/probe").await, (0, "recovered".into()));
            next.stop().await.unwrap();
            let idle = lab.handle(bx.id().as_str()).await;
            idle.mount().remove("/work").await.unwrap();
            idle.start().await.unwrap();
            first_process(&idle, 3, "absent").await;
            idle.stop().await.unwrap();
        }

        let bx = lab.create(options()).await;
        bx.start().await.unwrap();
        // Each owner finishes the real write and discards the result, as a disconnected client does.
        let (handle, directory) = (bx.mount(), request(data.path(), "/work", false));
        tokio::spawn(async move {
            let _ = handle.add(directory).await;
        })
        .await
        .unwrap();
        assert_eq!(
            bx.mount().get("/work").await.unwrap().unwrap().state,
            MountState::Mounted
        );
        bx.stop().await.unwrap();
        let next = lab.handle(bx.id().as_str()).await;
        assert_eq!(
            next.mount().get("/work").await.unwrap().unwrap().state,
            MountState::Configured
        );
        next.start().await.unwrap();
        first_process(&next, 2, "recovered").await;
        let handle = next.mount();
        tokio::spawn(async move {
            let _ = handle.remove("/work").await;
        })
        .await
        .unwrap();
        assert!(next.mount().get("/work").await.unwrap().is_none());
        next.stop().await.unwrap();
        let last = lab.handle(bx.id().as_str()).await;
        last.start().await.unwrap();
        first_process(&last, 3, "absent").await;
        assert!(matches!(
            last.mount().remove("/work").await,
            Err(BoxliteError::NotFound(_))
        ));
        last.stop().await.unwrap();
    })
    .await;
}

#[tokio::test]
#[ignore = "requires native runtime, KVM and VMM_KERNEL"]
async fn a_directory_stays_mounted_while_a_mount_sits_below_it() {
    scenario(async |lab| {
        let (data, nested) = (source("above"), source("below"));
        let mut opts = options();
        opts.mounts.push(MountSpec::bind_mount(
            data.path().to_str().unwrap(),
            "/work",
        ));
        opts.mounts.push(MountSpec::bind_mount(
            nested.path().to_str().unwrap(),
            "/work/nested",
        ));
        let bx = lab.create(opts).await;
        bx.start().await.unwrap();
        assert_eq!(
            run(&bx, "cat /work/nested/probe").await,
            (0, "below".into())
        );

        // The guest keeps a parent mounted while a child is mounted, so the
        // refusal comes before anything is marked.
        let error = bx.mount().remove("/work").await.unwrap_err();
        assert!(
            matches!(error, BoxliteError::InvalidState(_))
                && error.to_string().contains("/work/nested"),
            "{error}"
        );
        assert_eq!(
            bx.mount()
                .get("/work")
                .await
                .unwrap()
                .map(|mount| mount.state),
            Some(MountState::Mounted)
        );
        assert_eq!(run(&bx, "cat /work/probe").await, (0, "above".into()));

        // The child goes first, then the parent.
        bx.mount().remove("/work/nested").await.unwrap();
        bx.mount().remove("/work").await.unwrap();
        assert!(bx.mount().list().await.unwrap().is_empty());
        bx.stop().await.unwrap();
    })
    .await;
}

#[tokio::test]
#[ignore = "requires native runtime, KVM and VMM_KERNEL"]
async fn two_mounts_at_one_destination_are_refused_before_the_workload_runs() {
    scenario(async |lab| {
        let (first, second) = (source("first"), source("second"));
        let mut opts = options();
        for (data, target) in [(first.path(), "/work"), (second.path(), "/work/")] {
            opts.mounts
                .push(MountSpec::bind_mount(data.to_str().unwrap(), target));
        }
        let bx = lab.create(opts).await;
        // Neither of two mounts on one directory could be detached alone.
        let error = bx.start().await.unwrap_err().to_string();
        assert!(error.contains("another declared directory"), "{error}");
        assert!(bx.info().await.unwrap().pid.is_none());
    })
    .await;
}

#[tokio::test]
#[ignore = "requires native runtime, KVM and VMM_KERNEL"]
async fn directories_nested_at_runtime_come_back_in_order_after_a_restart() {
    scenario(async |lab| {
        let (above, below) = (source("above"), source("below"));
        let bx = lab.create(options()).await;
        let id = bx.id().to_string();
        bx.start().await.unwrap();
        bx.mount()
            .add(request(above.path(), "/nest", false))
            .await
            .unwrap();
        bx.mount()
            .add(request(below.path(), "/nest/child", false))
            .await
            .unwrap();
        assert_eq!(run(&bx, "cat /nest/child/probe").await, (0, "below".into()));
        bx.stop().await.unwrap();

        // Mounts apply in list order at start, so the parent comes first.
        let bx = lab.handle(&id).await;
        bx.start().await.unwrap();
        assert_eq!(
            run(&bx, "cat /nest/probe /nest/child/probe").await,
            (0, "abovebelow".into())
        );
        bx.mount().remove("/nest/child").await.unwrap();
        bx.mount().remove("/nest").await.unwrap();
        assert!(bx.mount().list().await.unwrap().is_empty());
        bx.stop().await.unwrap();
    })
    .await;
}

#[tokio::test]
#[ignore = "requires native runtime, KVM and VMM_KERNEL"]
async fn a_directory_may_not_cover_a_mount_the_box_already_has() {
    scenario(async |lab| {
        let (cover, inner) = (source("cover"), source("inner"));
        let mut opts = options();
        opts.mounts.push(MountSpec::bind_mount(
            inner.path().to_str().unwrap(),
            "/work/inner",
        ));
        let bx = lab.create(opts).await;
        let cover = request(cover.path(), "/work", false);

        // A saved directory applies after the box's own mounts, so it would hide this one.
        let error = bx.mount().add(cover.clone()).await.unwrap_err();
        assert!(
            matches!(error, BoxliteError::InvalidState(_))
                && error.to_string().contains("/work/inner"),
            "{error}"
        );
        assert_eq!(bx.mount().get("/work").await.unwrap(), None);

        // The same holds while the box runs: either mount could then no longer leave alone.
        bx.start().await.unwrap();
        let error = bx.mount().add(cover).await.unwrap_err();
        assert!(
            matches!(error, BoxliteError::InvalidState(_))
                && error.to_string().contains("/work/inner"),
            "{error}"
        );
        assert_eq!(bx.mount().get("/work").await.unwrap(), None);
        assert_eq!(run(&bx, "cat /work/inner/probe").await, (0, "inner".into()));
        bx.stop().await.unwrap();
    })
    .await;
}
