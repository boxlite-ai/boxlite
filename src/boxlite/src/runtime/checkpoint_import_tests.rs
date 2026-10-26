//! Import flow tests with a stand-in shim: a `sleep` process, a fake owner
//! on the box's control socket and the files libkrun would hand over.
//! The import itself is Linux x86_64 only, like checkpoints.

use super::*;

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
#[tokio::test]
async fn checkpoint_import_is_unsupported_off_linux_x86_64() {
    let home = tempfile::TempDir::new_in("/tmp").unwrap();
    let runtime = crate::runtime::rt_impl::RuntimeImpl::new_for_test(
        crate::runtime::options::BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            image_registries: vec![],
            ..Default::default()
        },
    )
    .unwrap();
    let result = import_checkpoint(
        &runtime,
        &home.path().join("missing.ckpt"),
        CheckpointImportOptions::default(),
    )
    .await;
    assert!(
        matches!(result, Err(BoxliteError::Unsupported(_))),
        "{:?}",
        result.err()
    );
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod linux {
    use super::*;
    use crate::litebox::checkpoint::archive;
    use crate::litebox::checkpoint::test_support::{
        DISKS, FakeGuest, image_for, layout_for, serve_guest, write_checkpoint,
    };
    use crate::runtime::options::{BoxliteOptions, VolumeSpec};
    use crate::runtime::rt_impl::RuntimeImpl;
    use crate::util::{PidFileWriter, PidRecord, ShimPidRecord, is_process_alive};
    use crate::vmm::checkpoint::fake::{self, FakeOwner};
    use crate::vmm::checkpoint::{CheckpointStart, VmRunState};
    use crate::vmm::controller::VmmMetrics;
    use std::sync::{Arc, Mutex};
    use tempfile::TempDir;

    /// What the stand-in shim does after "restoring".
    #[derive(Clone, Copy, PartialEq)]
    enum Shim {
        /// Hands the copies over and reports paused.
        Restores,
        /// Hands the copies over, then fails and exits (the start failing
        /// after libkrun's handoff, e.g. its exit watcher not starting).
        FailsAfterHandoff,
        /// Reports a share copy outside the box's restored tree.
        ForeignShare,
        /// Hands over a disk shorter than the image's.
        ShortDisk,
    }

    struct Handler(std::process::Child);

    impl VmmHandler for Handler {
        fn stop(&mut self) -> BoxliteResult<()> {
            let _ = self.0.kill();
            let _ = self.0.wait();
            Ok(())
        }
        fn metrics(&self) -> BoxliteResult<VmmMetrics> {
            Ok(VmmMetrics::default())
        }
        fn is_running(&self) -> bool {
            true
        }
        fn pid(&self) -> u32 {
            self.0.id()
        }
    }

    struct Launcher {
        shim: Shim,
        owner: Arc<FakeOwner>,
        guest: Arc<FakeGuest>,
        /// Each launch's spec as JSON, and whether its console log existed.
        launches: Mutex<Vec<(serde_json::Value, bool)>>,
        pids: Mutex<Vec<u32>>,
    }

    #[async_trait]
    impl ImportLauncher for Launcher {
        async fn launch(
            &self,
            _: &BoxID,
            spec: &InstanceSpec,
            _: &BoxOptions,
            layout: &BoxFilesystemLayout,
        ) -> BoxliteResult<Box<dyn VmmHandler>> {
            let checkpoint = spec.checkpoint.as_ref().expect("checkpoint launch");
            let CheckpointStart::Import(import) = &checkpoint.start else {
                panic!("an import must not cold boot");
            };
            self.launches.lock().unwrap().push((
                serde_json::to_value(spec).unwrap(),
                import.console_output.exists(),
            ));
            let mut child = std::process::Command::new("sleep")
                .arg("300")
                .spawn()
                .unwrap();
            let pid = child.id();
            self.pids.lock().unwrap().push(pid);
            PidFileWriter::at(&layout.pid_file_path())
                .unwrap()
                .write_shim(&ShimPidRecord::with_runtime_port_control(PidRecord {
                    pid,
                    start_time: crate::util::process_start_time(pid),
                }))
                .unwrap();

            // libkrun's handoff: RAW disks in guest order and share copies.
            let disks = import.disk_dir.as_ref().unwrap();
            let fs = import.fs_dir.as_ref().unwrap();
            std::fs::create_dir(disks).unwrap();
            for (i, len) in DISKS.iter().enumerate() {
                let len = if self.shim == Shim::ShortDisk {
                    len - 1
                } else {
                    *len
                };
                let file = std::fs::File::create(disks.join(format!("disk-{i}.raw"))).unwrap();
                file.set_len(len).unwrap();
            }
            std::fs::create_dir_all(fs.join("0/containers")).unwrap();
            std::fs::create_dir_all(fs.join("1")).unwrap();
            let shared = match self.shim {
                Shim::ForeignShare => layout.root().to_path_buf(),
                _ => fs.join("0"),
            };
            *self.owner.restored.lock().unwrap() = vec![
                (mount_tags::SHARED.into(), shared),
                (archive::volume_tag(0), fs.join("1")),
            ];
            fake::serve(
                &checkpoint.control_socket,
                &checkpoint.export_dir,
                self.owner.clone(),
            );
            if let boxlite_shared::BoxTransport::Unix { socket_path } = &spec.transport {
                serve_guest(socket_path, self.guest.clone());
            }
            if self.shim == Shim::FailsAfterHandoff {
                self.owner.set(VmRunState::Failed);
                child.kill().unwrap();
                child.wait().unwrap();
            }
            Ok(Box::new(Handler(child)))
        }
    }

    struct Fixture {
        home: TempDir,
        runtime: SharedRuntimeImpl,
        archive: PathBuf,
        manifest: archive::Manifest,
        launcher: Launcher,
    }

    fn fixture(shim: Shim) -> Fixture {
        let home = TempDir::new_in("/tmp").unwrap();
        let runtime = RuntimeImpl::new_for_test(BoxliteOptions {
            home_dir: home.path().to_path_buf(),
            image_registries: vec![],
            ..Default::default()
        })
        .unwrap();
        let source_volume = home.path().join("source-volume");
        std::fs::create_dir(&source_volume).unwrap();
        let mut options = BoxOptions {
            volumes: vec![VolumeSpec::bind_mount(
                source_volume.to_str().unwrap(),
                "/data",
            )],
            ..Default::default()
        };
        options.advanced.checkpoint_enabled = true;
        // Keep the box after it stops, so its record can be inspected.
        options.auto_delete = Some(0);
        let container_id = ContainerID::new();
        let guest = FakeGuest::new(container_id.as_str());
        let archive = home.path().join("box.ckpt");
        let manifest = write_checkpoint(
            &archive,
            &options,
            guest.identity(),
            &image_for(&layout_for(&options)),
        );
        Fixture {
            home,
            runtime,
            archive,
            manifest,
            launcher: Launcher {
                shim,
                owner: FakeOwner::new(VmRunState::Paused),
                guest,
                launches: Mutex::new(Vec::new()),
                pids: Mutex::new(Vec::new()),
            },
        }
    }

    impl Fixture {
        async fn import(&self) -> BoxliteResult<LiteBox> {
            import_with(
                &self.runtime,
                &self.archive,
                CheckpointImportOptions {
                    name: Some("restored".into()),
                },
                &self.launcher,
            )
            .await
        }

        /// Nothing of a failed import is left: no box, home, lock or shim;
        /// the checkpoint and a foreign file beside the boxes are untouched.
        async fn assert_nothing_left(&self, foreign: &Path) {
            assert!(self.runtime.list_info().await.unwrap().is_empty());
            let homes: Vec<_> = std::fs::read_dir(self.runtime.layout.boxes_dir())
                .unwrap()
                .map(|entry| entry.unwrap().path())
                .filter(|path| path != foreign)
                .collect();
            assert!(homes.is_empty(), "left behind: {homes:?}");
            assert_eq!(std::fs::read(foreign).unwrap(), b"foreign");
            assert!(self.archive.exists());
            assert_eq!(self.runtime.lock_manager.allocated_count().unwrap(), 0);
            for pid in self.launcher.pids.lock().unwrap().iter() {
                assert!(!is_process_alive(*pid), "shim {pid} still runs");
            }
        }

        fn foreign(&self) -> PathBuf {
            let foreign = self.runtime.layout.boxes_dir().join("foreign");
            std::fs::create_dir_all(self.runtime.layout.boxes_dir()).unwrap();
            std::fs::write(&foreign, b"foreign").unwrap();
            foreign
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn checkpoint_import_publishes_a_paused_box_with_a_new_host_identity() {
        let fx = fixture(Shim::Restores);
        let litebox = fx.import().await.unwrap();
        let bx = litebox.local_backend("test").unwrap();
        let home = bx.layout.root().to_path_buf();
        let restored = home.join("restored");

        // New host identity, the guest's own container ID.
        assert_ne!(bx.config.id.as_str(), fx.manifest.source_box_id);
        assert_eq!(bx.config.name.as_deref(), Some("restored"));
        assert_eq!(
            bx.config.container.id.as_str(),
            fx.manifest.guest.container_id
        );
        let info = fx
            .runtime
            .get_info(bx.config.id.as_str())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(info.status, BoxStatus::Paused);

        // The restored copies are recorded and the volume maps to its copy.
        let state = fx.runtime.box_manager.update_box(&bx.config.id).unwrap();
        assert_eq!(state.checkpoint_guest.as_ref(), Some(&fx.manifest.guest));
        let storage = state.restored_storage.expect("restored storage");
        let disks: Vec<_> = storage
            .disks
            .iter()
            .map(|d| (d.path.clone(), d.format, d.read_only))
            .collect();
        assert_eq!(
            disks,
            [
                (
                    restored.join("disks/disk-0.raw"),
                    crate::vmm::DiskFormat::Raw,
                    false
                ),
                (
                    restored.join("disks/disk-1.raw"),
                    crate::vmm::DiskFormat::Raw,
                    true
                ),
            ]
        );
        assert_eq!(storage.shared_dir, restored.join("fs/0"));
        assert_eq!(bx.layout.shared_dir(), restored.join("fs/0"));
        assert_eq!(
            Path::new(&bx.config.options.volumes[0].host_path),
            restored.join("fs/1")
        );
        assert!(!bx.layout.checkpoint_dir().join("import.krunvm").exists());

        // The shim was asked to restore, not boot: no disk or share of its
        // own, a console log that did not exist yet.
        let launches = fx.launcher.launches.lock().unwrap().clone();
        assert_eq!(launches.len(), 1);
        let (spec, console_existed) = &launches[0];
        assert!(!console_existed);
        assert_eq!(spec["fs_shares"]["shares"], serde_json::json!([]));
        assert_eq!(spec["block_devices"]["devices"], serde_json::json!([]));
        assert_eq!(spec["kernel"], serde_json::Value::Null);
        let start = &spec["checkpoint"]["start"];
        assert_eq!(start["kind"], "import");
        assert_eq!(start["disk_dir"], restored.join("disks").to_str().unwrap());

        // Paused until resumed; no guest RPC so far.
        assert!(fx.launcher.guest.calls().is_empty());
        assert!(litebox.exec(crate::BoxCommand::new("true")).await.is_err());
        assert!(fx.launcher.guest.calls().is_empty());
        drop(fx.home);
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn checkpoint_import_resumes_into_the_same_guest_without_cold_init() {
        let fx = fixture(Shim::Restores);
        let litebox = fx.import().await.unwrap();
        litebox.resume().await.unwrap();
        // Only the identity check reached the guest: no Guest.Init,
        // Container.Init or Container.Start, and no ready wait.
        let calls = fx.launcher.guest.calls();
        assert!(!calls.is_empty());
        assert!(
            calls.iter().all(|call| *call == "Guest.RunningState"),
            "{calls:?}"
        );
        assert_eq!(fx.launcher.owner.calls(), ["resume"]);
        let bx = litebox.local_backend("test").unwrap();
        assert_eq!(
            fx.runtime
                .box_manager
                .update_box(&bx.config.id)
                .unwrap()
                .status,
            BoxStatus::Running
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn checkpoint_import_resume_into_another_guest_stops_the_vm() {
        let fx = fixture(Shim::Restores);
        let litebox = fx.import().await.unwrap();
        // The same container ID, freshly booted: another agent boot.
        *fx.launcher.guest.boot_id.lock().unwrap() = "boot-2".into();
        let error = litebox.resume().await.unwrap_err();
        assert!(error.to_string().contains("different guest"), "{error}");
        let pid = fx.launcher.pids.lock().unwrap()[0];
        assert!(!is_process_alive(pid), "the VM must be stopped");
        let bx = litebox.local_backend("test").unwrap();
        assert_eq!(
            fx.runtime
                .box_manager
                .update_box(&bx.config.id)
                .unwrap()
                .status,
            BoxStatus::Stopped
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn checkpoint_import_failure_after_the_handoff_leaves_nothing() {
        for shim in [Shim::FailsAfterHandoff, Shim::ForeignShare, Shim::ShortDisk] {
            let fx = fixture(shim);
            let foreign = fx.foreign();
            let error = fx.import().await.err().expect("import must fail");
            let expected = match shim {
                Shim::FailsAfterHandoff => "exited before the checkpoint was restored",
                Shim::ForeignShare => "is not a directory inside",
                _ => "byte file",
            };
            assert!(error.to_string().contains(expected), "{error}");
            fx.assert_nothing_left(&foreign).await;
        }
    }

    /// The box becomes visible only as the import completes: while the
    /// import is pending no box is published, and cancelling it then leaves
    /// nothing behind.
    #[tokio::test(flavor = "multi_thread")]
    async fn checkpoint_import_publishes_nothing_until_it_completes() {
        let published = |fx: &Fixture| !fx.runtime.box_manager.all_boxes(true).unwrap().is_empty();

        let fx = fixture(Shim::Restores);
        let mut import = Box::pin(fx.import());
        loop {
            match futures::poll!(import.as_mut()) {
                std::task::Poll::Ready(result) => {
                    result.unwrap();
                    break;
                }
                std::task::Poll::Pending => {
                    assert!(
                        !published(&fx),
                        "a pending import already published its box"
                    );
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            }
        }
        assert!(published(&fx));

        // Cancelled once its shim runs: stopped, and only its files removed.
        let fx = fixture(Shim::Restores);
        let foreign = fx.foreign();
        let mut import = Box::pin(fx.import());
        while fx.launcher.pids.lock().unwrap().is_empty() {
            assert!(futures::poll!(import.as_mut()).is_pending());
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        drop(import);
        fx.assert_nothing_left(&foreign).await;
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn checkpoint_import_refuses_a_corrupt_file_before_creating_anything() {
        let fx = fixture(Shim::Restores);
        let foreign = fx.foreign();
        let mut bytes = std::fs::read(&fx.archive).unwrap();
        let at = bytes.len() - 2048;
        bytes[at] ^= 1;
        std::fs::write(&fx.archive, &bytes).unwrap();
        let error = fx.import().await.err().expect("corrupt checkpoint");
        assert!(error.to_string().contains("SHA-256"), "{error}");
        assert!(fx.launcher.launches.lock().unwrap().is_empty());
        fx.assert_nothing_left(&foreign).await;
    }

    #[test]
    fn checkpoint_import_refuses_files_above_the_box_file_size_limit() {
        let fx = fixture(Shim::Restores);
        let limit = fx.manifest.boot.options.shim_file_size_limit();
        verified_options(&fx.manifest, limit).unwrap();
        let error = verified_options(&fx.manifest, limit + 1).unwrap_err();
        assert!(error.to_string().contains("file size limit"), "{error}");
        let mut big = fx.manifest.clone();
        big.layout.disks[0].bytes = limit + 1;
        assert!(verified_options(&big, 0).is_err());

        let mut plain = fx.manifest.clone();
        plain.boot.options.advanced.checkpoint_enabled = false;
        assert!(verified_options(&plain, 0).is_err());
    }
}
