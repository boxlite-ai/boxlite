//! OpenSpec PR-3: stopped changes against real admission and SQLite. The
//! running paths are verified on KVM in `tests/runtime_mounts.rs`.

use std::path::{Path, PathBuf};

use boxlite_shared::errors::BoxliteError;
use chrono::Utc;

use crate::BoxID;
use crate::db::{BoxStore, Database, Mounts};
use crate::experimental::ExperimentalFeatures;
use crate::litebox::box_impl::BoxImpl;
use crate::litebox::config::{BoxConfig, ContainerRuntimeConfig};
use crate::litebox::state::{BoxState, BoxStatus};
use crate::runtime::id::BoxIDMint;
use crate::runtime::options::{BoxOptions, BoxliteOptions, MountSpec, RootfsSpec};
use crate::runtime::rt_impl::{RuntimeImpl, SharedRuntimeImpl};
use crate::runtime::types::ContainerID;
use crate::vmm::VmmKind;

use super::{MountRequest, MountState};

const WORK: &str = "/work";

pub(crate) struct Fixture {
    /// Keeps the runtime's home alive.
    _home: tempfile::TempDir,
    pub(crate) runtime: SharedRuntimeImpl,
    pub(crate) id: BoxID,
    pub(crate) config: BoxConfig,
    pub(crate) source: PathBuf,
}

impl Fixture {
    pub(crate) fn new(status: BoxStatus) -> Self {
        Self::with_mounts(status, Vec::new())
    }

    /// A native box with its locks allocated, created with `mounts`.
    pub(crate) fn with_mounts(status: BoxStatus, mounts: Vec<MountSpec>) -> Self {
        let home = tempfile::tempdir_in("/tmp").unwrap();
        let runtime = RuntimeImpl::new_for_test_with_features(
            BoxliteOptions {
                home_dir: home.path().into(),
                image_registries: vec![],
                ..Default::default()
            },
            ExperimentalFeatures::parse("native-vmm").unwrap(),
        )
        .unwrap();
        let source = home.path().join("data");
        std::fs::create_dir(&source).unwrap();
        let lock_id = runtime.lock_manager.allocate().unwrap();
        runtime
            .disk_lock_manager
            .allocate_and_retrieve(lock_id)
            .unwrap();
        let mut state = BoxState::new();
        state.set_lock_id(lock_id);
        state.status = status;
        if matches!(status, BoxStatus::Paused | BoxStatus::Running) {
            state.set_pid(Some(4242));
        }
        let id = BoxIDMint::mint();
        let config = BoxConfig {
            id: id.clone(),
            name: None,
            created_at: Utc::now(),
            container: ContainerRuntimeConfig {
                id: ContainerID::new(),
            },
            options: BoxOptions {
                rootfs: RootfsSpec::Image("alpine:latest".into()),
                mounts,
                ..Default::default()
            },
            engine_kind: VmmKind::Native,
            box_home: runtime.layout.boxes_dir().join(id.as_str()),
        };
        runtime.box_manager.add_box(&config, &state).unwrap();
        Self {
            _home: home,
            runtime,
            id,
            config,
            source,
        }
    }

    /// The store as another process opens it.
    fn reopened(&self) -> BoxStore {
        BoxStore::new(Database::open(&self.runtime.layout.db_dir().join("boxlite.db")).unwrap())
    }

    pub(crate) fn handle(&self) -> BoxImpl {
        BoxImpl::new(
            self.config.clone(),
            self.runtime.box_manager.update_box(&self.id).unwrap(),
            self.runtime.clone(),
            self.runtime.shutdown_token.child_token(),
        )
    }

    pub(crate) fn request(&self) -> MountRequest {
        MountRequest {
            source: self.source.clone(),
            target: WORK.into(),
            read_only: false,
        }
    }

    /// Whether the options of the next start carry a declaration at `WORK`.
    fn boots_with(&self, mounts: &Mounts) -> bool {
        let mut options = self.config.options.clone();
        mounts.apply_to_boot(&mut options);
        options.mounts.iter().any(|mount| mount.target == WORK)
            || options
                .volumes
                .iter()
                .any(|volume| volume.guest_path == WORK)
    }
}

#[tokio::test]
async fn stopped_changes_are_persistent_and_do_not_start_a_vm() {
    for status in [BoxStatus::Configured, BoxStatus::Stopped] {
        let fx = Fixture::new(status);
        let bx = fx.handle();
        assert!(bx.mount_get(Path::new(WORK)).await.unwrap().is_none());
        let added = bx.mount_add(fx.request()).await.unwrap();
        assert_eq!(added.state, MountState::Configured);
        assert_eq!(
            bx.mount_list().await.unwrap().as_slice(),
            std::slice::from_ref(&added)
        );
        assert_eq!(
            fx.reopened().mounts(fx.id.as_str()).unwrap().lookup(WORK),
            Some(added)
        );
        assert!(fx.boots_with(&fx.reopened().mounts(fx.id.as_str()).unwrap()));
        let state = fx.runtime.box_manager.update_box(&fx.id).unwrap();
        assert_eq!((state.status, state.pid), (status, None));
        assert!(matches!(
            bx.mount_add(fx.request()).await,
            Err(BoxliteError::InvalidState(_))
        ));

        // A declaration whose source is gone still goes.
        std::fs::remove_dir(&fx.source).unwrap();
        bx.mount_remove(Path::new(WORK)).await.unwrap();
        assert!(bx.mount_get(Path::new(WORK)).await.unwrap().is_none());
        let mounts = fx.reopened().mounts(fx.id.as_str()).unwrap();
        assert!(mounts.lookup(WORK).is_none() && !fx.boots_with(&mounts));
        assert!(matches!(
            bx.mount_remove(Path::new(WORK)).await,
            Err(BoxliteError::NotFound(_))
        ));
    }
}

#[tokio::test]
async fn paused_unsupported_and_unsafe_changes_are_refused() {
    let fx = Fixture::new(BoxStatus::Paused);
    let refused = [
        fx.handle().mount_add(fx.request()).await.map(|_| ()),
        fx.handle().mount_remove(Path::new(WORK)).await,
    ];
    assert!(
        refused
            .iter()
            .all(|result| matches!(result, Err(BoxliteError::InvalidState(_))))
    );

    let mut fx = Fixture::new(BoxStatus::Stopped);
    for target in ["/", "relative", "/a/../b"] {
        let request = MountRequest {
            target: target.into(),
            ..fx.request()
        };
        assert!(matches!(
            fx.handle().mount_add(request).await,
            Err(BoxliteError::InvalidArgument(_))
        ));
    }
    let request = MountRequest {
        source: fx.source.join("missing"),
        ..fx.request()
    };
    assert!(matches!(
        fx.handle().mount_add(request).await,
        Err(BoxliteError::NotFound(_))
    ));
    fx.config.engine_kind = VmmKind::Libkrun;
    assert!(matches!(
        fx.handle().mount_add(fx.request()).await,
        Err(BoxliteError::Unsupported(_))
    ));
    fx.config.engine_kind = VmmKind::Native;
    fx.config.options.advanced.set_privileged(true);
    assert!(matches!(
        fx.handle().mount_add(fx.request()).await,
        Err(BoxliteError::Unsupported(_))
    ));
    assert!(
        fx.reopened()
            .mounts(fx.id.as_str())
            .unwrap()
            .visible()
            .is_empty()
    );
}

#[tokio::test]
async fn an_added_source_is_refused_once_it_is_a_link_in_any_spelling() {
    for slash in ["", "/"] {
        let fx = Fixture::new(BoxStatus::Stopped);
        let real = fx._home.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let request = MountRequest {
            source: PathBuf::from(format!("{}{slash}", fx.source.display())),
            ..fx.request()
        };
        fx.handle().mount_add(request).await.unwrap();
        std::fs::remove_dir(&fx.source).unwrap();
        std::os::unix::fs::symlink(&real, &fx.source).unwrap();
        let error = fx
            .reopened()
            .mounts(fx.id.as_str())
            .unwrap()
            .check_sources()
            .unwrap_err();
        assert!(matches!(error, BoxliteError::InvalidState(_)), "{error}");
    }
}

#[tokio::test]
async fn a_source_that_overlaps_a_delivered_directory_is_refused() {
    let fx = Fixture::new(BoxStatus::Stopped);
    let bx = fx.handle();
    let (parent, sibling) = (fx.source.join("parent"), fx.source.join("sibling"));
    let child = parent.join("child");
    for directory in [&parent, &child, &sibling] {
        std::fs::create_dir_all(directory).unwrap();
    }
    let add = |source: &Path, target: &str| MountRequest {
        source: source.into(),
        target: target.into(),
        read_only: false,
    };
    bx.mount_add(add(&parent, "/parent")).await.unwrap();

    // The same directory, below it, and above it: the next start could not
    // deliver the two as separate shares.
    std::os::unix::fs::symlink(&parent, fx.source.join("alias")).unwrap();
    for (source, target) in [
        (parent.clone(), "/again"),
        (child.clone(), "/child"),
        (fx.source.join("alias/child"), "/alias"),
        (fx.source.clone(), "/above"),
    ] {
        let error = bx.mount_add(add(&source, target)).await.unwrap_err();
        assert!(
            matches!(error, BoxliteError::InvalidState(_)) && error.to_string().contains("/parent"),
            "{target}: {error}"
        );
        assert_eq!(bx.mount_get(Path::new(target)).await.unwrap(), None);
    }

    // A directory beside it is delivered on its own.
    let sibling = bx.mount_add(add(&sibling, "/sibling")).await.unwrap();
    assert_eq!(sibling.state, MountState::Configured);
    assert_eq!(bx.mount_list().await.unwrap().len(), 2);
}

#[tokio::test]
async fn a_target_at_or_around_the_containers_own_mounts_is_refused() {
    let fx = Fixture::new(BoxStatus::Stopped);
    let bx = fx.handle();
    for target in [
        "/dev",
        "/dev/",
        "/dev/null",
        "/proc",
        "/sys/fs",
        "/tmp",
        "/tmp/work",
    ] {
        let request = MountRequest {
            target: target.into(),
            ..fx.request()
        };
        let error = bx.mount_add(request).await.unwrap_err();
        assert!(
            matches!(error, BoxliteError::InvalidArgument(_)),
            "{target}: {error}"
        );
    }

    // A path that only shares the spelling is another directory.
    let beside = MountRequest {
        target: "/tmpwork".into(),
        ..fx.request()
    };
    assert_eq!(
        bx.mount_add(beside).await.unwrap().state,
        MountState::Configured
    );
    assert_eq!(bx.mount_list().await.unwrap().len(), 1);
}
