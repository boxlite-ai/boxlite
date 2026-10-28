//! Bind external resources and a private QCOW2 before publishing a Paused box.
use crate::litebox::config::{BoxConfig, ContainerRuntimeConfig};
use crate::litebox::init::{checkpoint_import_spec, read_tail, spawn_vm};
use crate::litebox::{
    LiteBox,
    checkpoint::{
        RestoredDisk, RestoredStorage,
        pair::{self, Application},
        provider::{LocalCheckpointProvider, check_handle_flags},
    },
};
use crate::lock::LockId;
use crate::runtime::{
    id::{BoxID, BoxIDMint},
    layout::BoxFilesystemLayout,
    options::CheckpointImportOptions,
    rt_impl::SharedRuntimeImpl,
    types::{BoxState, BoxStatus, ContainerID},
};
use crate::vmm::checkpoint::{
    ControlClient, ControlRequest, ImportLaunch, VmRunState,
    protocol::DescriptorRequest,
    support::{self, Host},
};
use crate::vmm::controller::VmmHandler;
use crate::vmm::{ExitInfo, VmmKind};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::fs::{File, OpenOptions};
use std::os::fd::OwnedFd;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
const IMPORT_START_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const STATE_POLL: Duration = Duration::from_millis(100);
const SHIM_STDERR_TAIL: u64 = 16 * 1024;
fn invalid(why: impl std::fmt::Display) -> BoxliteError {
    pair::invalid(why)
}

pub(crate) async fn import_checkpoint(
    runtime: &SharedRuntimeImpl,
    path: &Path,
    options: CheckpointImportOptions,
) -> BoxliteResult<LiteBox> {
    support::check_host(Host::current())?;
    let pair = pair::open(path)?;
    let application: Application =
        serde_json::from_value(pair.dependencies.application.clone()).map_err(invalid)?;
    let local_paths = application.local_paths.as_ref().ok_or_else(|| invalid(
        "unsupported provider-era checkpoint: automatic local paths are absent; export a local-path checkpoint"
    ))?;
    let mut bindings = LocalCheckpointProvider::bind(&pair.dependencies, local_paths)?;
    pair.verify_disk()?;
    let mut box_options = application.options.clone();
    if u16::from(
        box_options
            .cpus
            .unwrap_or(crate::runtime::constants::vm_defaults::DEFAULT_CPUS),
    ) != pair.dependencies.cpus
        // The boot loader maps low RAM and the copied kernel in addition to
        // the configured MiB below the MMIO gap. Mapped bytes may exceed that
        // logical setting; they must still cover it.
        || (u64::from(
            box_options
                .memory_mib
                .unwrap_or(crate::runtime::constants::vm_defaults::DEFAULT_MEMORY_MIB),
        ) << 20)
            > pair.dependencies.memory_bytes
    {
        return Err(invalid(format!(
            "saved application resources exceed memory/device layout: cpus={:?}/{}, memory_mib={:?}, mapped_bytes={}",
            box_options.cpus,
            pair.dependencies.cpus,
            box_options.memory_mib,
            pair.dependencies.memory_bytes,
        )));
    }
    if bindings.shares.len() != pair.dependencies.shares.len() {
        return Err(invalid("share binding count differs"));
    }
    let container_id = ContainerID::parse(&application.guest.container_id)
        .ok_or_else(|| invalid("invalid saved container ID"))?;
    let boot_dependency = pair
        .dependencies
        .disk_dependencies
        .as_array()
        .and_then(|disks| disks.get(1))
        .and_then(|disk| disk.get("external_readonly_boot"))
        .ok_or_else(|| invalid("exact readonly boot dependency missing"))?;
    let boot_hash: [u8; 32] =
        serde_json::from_value(boot_dependency["sha256"].clone()).map_err(invalid)?;
    let boot_length = boot_dependency["length"]
        .as_u64()
        .ok_or_else(|| invalid("invalid boot length"))?;
    let mut cached_pin = None;
    let boot_path = if local_paths.boot_disk.try_exists().map_err(invalid)? {
        local_paths.boot_disk.clone()
    } else {
        let records = runtime
            .base_disk_mgr
            .store()
            .list_by_box("__global__", Some(crate::disk::BaseDiskKind::Rootfs))?;
        let mut found = None;
        for record in records {
            let path = PathBuf::from(record.base_path());
            let file = match File::open(&path) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(invalid(error)),
            };
            if file.metadata().map_err(invalid)?.len() == boot_length
                && pair::digest(&file, 0, boot_length)? == boot_hash
            {
                cached_pin = Some(record.id().clone());
                found = Some(path);
                break;
            }
        }
        found.ok_or_else(|| {
            invalid("exact readonly boot disk is absent at its saved path and in the runtime cache")
        })?
    };
    let boot_path = boot_path.canonicalize().map_err(invalid)?;
    if cached_pin.is_none() {
        cached_pin = runtime
            .base_disk_mgr
            .store()
            .find_by_base_path(&boot_path.to_string_lossy())?
            .map(|record| record.id().clone());
    }
    let boot = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&boot_path)
        .map_err(invalid)?;
    if boot.metadata().map_err(invalid)?.len() != boot_length
        || pair::digest(&boot, 0, boot_length)? != boot_hash
    {
        return Err(invalid("readonly boot dependency length/checksum mismatch"));
    }
    for (index, volume) in box_options.volumes.iter_mut().enumerate() {
        let tag = format!("uservol{index}");
        if let Some((_, bound)) = pair
            .dependencies
            .shares
            .iter()
            .zip(&bindings.shares)
            .find(|(share, _)| share.tag == tag)
        {
            volume.host_path = bound.root.to_string_lossy().into_owned();
            volume.managed_volume = None;
        }
    }
    box_options.sanitize()?;
    let runtime = runtime.clone();
    let worker_runtime = runtime.clone();
    let cancellation = runtime.shutdown_token.child_token();
    let canceller = crate::litebox::checkpoint::capture::CancelOnDrop(cancellation.clone());
    let task = tokio::spawn(async move {
        let runtime = worker_runtime;
        let box_id = BoxIDMint::mint();
        crate::litebox::operation::Reservation::provision(&runtime.layout, &box_id)?;
        let layout = runtime.layout.box_layout(box_id.as_str(), false)?;
        std::fs::create_dir(layout.root()).map_err(invalid)?;
        let mut attempt = Attempt {
            runtime: runtime.clone(),
            layout: layout.clone(),
            handler: None,
            lock: None,
            armed: true,
        };
        layout.prepare()?;
        let private_disk = layout.root().join("disks/disk.qcow2");
        let copy_path = private_disk.clone();
        let source = pair.disk;
        let copy_cancellation = cancellation.clone();
        tokio::task::spawn_blocking(move || {
            use std::io::{Read, Write};
            let mut source = source;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(copy_path)
                .map_err(invalid)?;
            let mut buffer = vec![0; 1 << 20];
            loop {
                if copy_cancellation.is_cancelled() {
                    return Err(BoxliteError::Stopped(
                        "checkpoint import copy cancelled".into(),
                    ));
                }
                let count = source.read(&mut buffer).map_err(invalid)?;
                if count == 0 {
                    break;
                }
                output.write_all(&buffer[..count]).map_err(invalid)?;
            }
            output.sync_all().map_err(invalid)
        })
        .await
        .map_err(invalid)??;
        if cancellation.is_cancelled() {
            return Err(BoxliteError::Stopped(
                "checkpoint import cancelled before spawn".into(),
            ));
        }
        let mut files: Vec<OwnedFd> = vec![
            File::open(&private_disk).map_err(invalid)?.into(),
            boot.into(),
        ];
        // The container backend must be writable and private, never the input pair.
        files[0] = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&private_disk)
            .map_err(invalid)?
            .into();
        let mut shares_json = Vec::new();
        let mut shared_dir = None;
        for (index, (share, bound)) in pair
            .dependencies
            .shares
            .iter()
            .zip(bindings.shares.iter_mut())
            .enumerate()
        {
            if share.vm_owned {
                let root = layout.root().join(format!("restored/boot-{index}"));
                std::fs::create_dir_all(&root).map_err(invalid)?;
                for directory in ["dev", "proc", "sys", "newroot"] {
                    std::fs::create_dir(root.join(directory)).map_err(invalid)?;
                }
                bound.root = root;
                // Directory handles refer to deterministic recipe objects only.
                for handle in share.state["handles"]
                    .as_array()
                    .ok_or_else(|| invalid("boot handle table missing"))?
                {
                    let object = handle["object"]
                        .as_u64()
                        .ok_or_else(|| invalid("invalid boot object index"))?
                        as usize;
                    let recipe = share
                        .objects
                        .get(object)
                        .and_then(|o| o.recipe.as_deref())
                        .ok_or_else(|| invalid("missing boot object recipe"))?;
                    if ![".", "dev", "proc", "sys", "newroot"].contains(&recipe) {
                        return Err(invalid("non-reconstructible boot object"));
                    }
                    let flags: i32 =
                        serde_json::from_value(handle["flags"].clone()).map_err(invalid)?;
                    check_handle_flags(flags)?;
                    let file = OpenOptions::new()
                        .read(true)
                        .custom_flags(flags | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                        .open(bound.root.join(recipe))
                        .map_err(invalid)?;
                    bound.handles.insert(
                        handle["handle"]
                            .as_u64()
                            .ok_or_else(|| invalid("invalid handle"))?,
                        file,
                    );
                }
            }
            if share.tag == crate::runtime::constants::mount_tags::SHARED {
                shared_dir = Some(bound.root.clone());
            }
            let mut objects = Vec::new();
            for object in bound.objects.drain(..) {
                objects.push(object.map(|file| {
                    let index = files.len();
                    files.push(file.into());
                    index
                }));
            }
            let mut handles = serde_json::Map::new();
            for (id, file) in std::mem::take(&mut bound.handles) {
                handles.insert(id.to_string(), serde_json::json!(files.len()));
                files.push(file.into());
            }
            let mut dax = Vec::new();
            for (object, writable, file) in bound.dax.drain(..) {
                dax.push(serde_json::json!({"object":object,"writable":writable,"fd":files.len()}));
                files.push(file.into());
            }
            shares_json.push(serde_json::json!({"root":bound.root,"objects":objects,"handles":handles,"dax":dax}));
        }
        let storage = RestoredStorage {
            disks: vec![
                RestoredDisk {
                    path: private_disk,
                    format: crate::vmm::DiskFormat::Qcow2,
                    read_only: false,
                },
                RestoredDisk {
                    path: boot_path,
                    format: crate::vmm::DiskFormat::Raw,
                    read_only: true,
                },
            ],
            shared_dir: shared_dir.ok_or_else(|| invalid("BoxLiteShared root is not bound"))?,
            container_image_config: application.container_image_config.clone(),
            boot: Some(crate::litebox::checkpoint::BootDependency {
                length: boot_length,
                sha256: boot_hash,
                base_id: cached_pin.clone(),
            }),
        };
        let launch = ImportLaunch {
            console_output: layout.console_output_path(),
        };
        let (mut spec, _network) = checkpoint_import_spec(
            &box_id,
            &box_options,
            &layout,
            &runtime,
            application.outbound_policy.as_ref(),
            launch,
        )?;
        for (share, bound) in pair.dependencies.shares.iter().zip(&bindings.shares) {
            spec.fs_shares
                .add(share.tag.clone(), bound.root.clone(), share.read_only);
        }
        attempt.handler = Some(spawn_vm(&box_id, &spec, &box_options, &layout).await?);
        let pid = attempt.handler.as_ref().expect("spawned handler").pid();
        let control = ControlClient::new(layout.control_socket_path());
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if cancellation.is_cancelled() {
                return Err(BoxliteError::Stopped(
                    "checkpoint import binding cancelled".into(),
                ));
            }
            match control
                .descriptors(DescriptorRequest::Capabilities, Vec::new())
                .await
            {
                Ok((reply, _)) if reply.error.is_none() => break,
                Err(crate::vmm::checkpoint::ControlError::Unavailable(_))
                    if Instant::now() < deadline =>
                {
                    tokio::time::sleep(STATE_POLL).await
                }
                result => {
                    return Err(BoxliteError::Engine(format!(
                        "checkpoint import control unavailable: {result:?}"
                    )));
                }
            }
        }
        let mut transfer = vec![pair.memory.into()];
        transfer.extend(files);
        crate::litebox::checkpoint::capture::request(
            &control,
            DescriptorRequest::Import {
                bindings: serde_json::json!({"disks":[0,1],"shares":shares_json}),
            },
            transfer,
        )
        .await?;
        tokio::select! {
            result = wait_paused(&control,pid,&layout) => result?,
            () = cancellation.cancelled() => return Err(BoxliteError::Stopped("checkpoint restore cancelled".into())),
        }
        if cancellation.is_cancelled() {
            return Err(BoxliteError::Stopped(
                "checkpoint import cancelled before publication".into(),
            ));
        }
        let config = BoxConfig {
            id: box_id.clone(),
            name: options.name,
            created_at: chrono::Utc::now(),
            container: ContainerRuntimeConfig { id: container_id },
            options: box_options,
            engine_kind: VmmKind::Libkrun,
            box_home: layout.root().into(),
        };
        let mut state = BoxState::new();
        state.set_status(BoxStatus::Paused);
        state.set_pid(Some(pid));
        state.start_mode = Some(support::StartMode::Owner { protocol: 2 });
        state.outbound_policy = application.outbound_policy;
        state.checkpoint_guest = Some(application.guest);
        state.checkpoint_paths = application.local_paths.map(|mut paths| {
            paths.boot_disk = storage.disks[1].path.clone();
            paths
        });
        state.restored_storage = Some(storage);
        let lock = runtime.lock_manager.allocate()?;
        attempt.lock = Some(lock);
        state.set_lock_id(lock);
        if let Some(pin) = &cached_pin {
            runtime
                .base_disk_mgr
                .store()
                .add_ref(pin, box_id.as_str())?;
        }
        Ok((attempt, config, state))
    });
    let (attempt, config, state) = task.await.map_err(invalid)??;
    if canceller.0.is_cancelled() {
        return Err(BoxliteError::Stopped(
            "checkpoint import cancelled before publication".into(),
        ));
    }
    let box_id = config.id.clone();
    runtime.box_manager.add_box(&config, &state)?;
    let (box_impl, inserted) = runtime.get_or_create_box_impl(config, state);
    if !inserted {
        runtime.box_manager.remove_box(&box_id)?;
        return Err(invalid("box name conflict"));
    }
    // No await or fallible operation follows publication in the caller's poll.
    box_impl.hold_imported_shim(attempt.publish());
    drop(canceller);
    Ok(crate::runtime::rt_impl::litebox_from_impl(box_impl))
}
/// Wait until the owner reports the restored VM paused. The shim dying,
/// any other state, or the deadline fails the import.
async fn wait_paused(
    control: &ControlClient,
    pid: u32,
    layout: &BoxFilesystemLayout,
) -> BoxliteResult<()> {
    let deadline = Instant::now() + IMPORT_START_TIMEOUT;
    loop {
        if !crate::util::is_process_alive(pid) {
            // A failed import removes the box directory and the shim's stderr
            // with it, so its tail (libkrun's reason) goes to the operator log.
            if let Some(tail) = read_tail(&layout.stderr_file_path(), SHIM_STDERR_TAIL) {
                tracing::error!("checkpoint import shim stderr (tail):\n{tail}");
            }
            let why = ExitInfo::from_file(&layout.exit_file_path())
                .map(|info| format!(": {info:?}"))
                .unwrap_or_default();
            return Err(BoxliteError::Engine(format!(
                "the shim exited before the checkpoint was restored{why}"
            )));
        }
        // Not served yet, or no answer: ask again.
        if let Ok(reply) = control.send(&ControlRequest::State).await
            && reply.error.is_none()
        {
            match reply.state {
                VmRunState::Paused if reply.in_flight.is_none() => return Ok(()),
                VmRunState::Configured | VmRunState::Starting | VmRunState::Paused => {}
                state => {
                    return Err(BoxliteError::Engine(format!(
                        "the restored VM is {state}, not paused"
                    )));
                }
            }
        }
        if Instant::now() >= deadline {
            return Err(BoxliteError::Engine(format!(
                "the checkpoint was not restored within {}s",
                IMPORT_START_TIMEOUT.as_secs()
            )));
        }
        tokio::time::sleep(STATE_POLL).await;
    }
}

/// What an import created, removed again unless the box is published.
struct Attempt {
    runtime: SharedRuntimeImpl,
    layout: BoxFilesystemLayout,
    handler: Option<Box<dyn VmmHandler>>,
    lock: Option<LockId>,
    armed: bool,
}

impl Attempt {
    /// The box is published: keep everything and hand the shim over.
    fn publish(mut self) -> Box<dyn VmmHandler> {
        self.armed = false;
        self.handler
            .take()
            .expect("an attempt is published only after its shim started")
    }
}

impl Drop for Attempt {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        // The shim goes first: until it is gone it may still write the
        // restored tree.
        if let Some(handler) = self.handler.take() {
            let pid = handler.pid();
            let id = BoxID::parse(self.layout.root().file_name().unwrap().to_str().unwrap())
                .expect("attempt has a minted box ID");
            if let Err(error) = crate::litebox::checkpoint::capture::stop_and_join_sync(
                &crate::util::PidFileReader::at(self.layout.pid_file_path()),
                pid,
                id,
            ) {
                tracing::error!(pid, %error, home = %self.layout.root().display(),
                    "Failed import writer could not be joined; retaining attempt resources");
                return;
            }
        }
        if let Some(lock) = self.lock.take()
            && let Err(e) = self.runtime.lock_manager.free(lock)
        {
            tracing::warn!(error = %e, "Failed to free the import's lock");
        }
        if let Some(id) = self.layout.root().file_name().and_then(|id| id.to_str()) {
            if let Err(error) = self
                .runtime
                .base_disk_mgr
                .store()
                .remove_all_refs_for_box(id)
            {
                tracing::warn!(%error,"Failed to release failed import boot pin");
            }
        }
        if let Err(e) = self.layout.cleanup() {
            tracing::warn!(error = %e, "Failed to remove the failed import's box home");
        }
    }
}
