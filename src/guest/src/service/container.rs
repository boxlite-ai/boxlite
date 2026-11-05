#![cfg(target_os = "linux")]
//! Container service implementation.
//!
//! Handles OCI container lifecycle (Init RPC).

use std::path::{Component, Path, PathBuf};

use crate::container::zygote::{AttachSpec, ZYGOTE};
use crate::service::server::GuestServer;
use crate::storage::attach::validate_destination;
use boxlite_shared::errors::BoxliteError;
use boxlite_shared::{
    container_init_response, container_start_response, rootfs_init, Container as ContainerService,
    ContainerInitError, ContainerInitErrorKind, ContainerInitRequest, ContainerInitResponse,
    ContainerInitSuccess, ContainerMountRequest, ContainerMountResponse, ContainerStartRequest,
    ContainerStartResponse, ContainerStartSuccess, Filesystem, RootfsInit,
};
use nix::mount::{mount, MsFlags};
use tonic::{Request, Response, Status};
use tracing::{debug, error, info, warn};

use crate::container::{
    validate_mount_override, CapabilitySet, Container, ContainerDevices, MountOverride, UserMount,
};
use crate::layout::GuestLayout;
use crate::storage::block_device::BlockDeviceMount;

fn internal_init_error(reason: impl Into<String>) -> ContainerInitError {
    ContainerInitError {
        reason: reason.into(),
        kind: ContainerInitErrorKind::Internal as i32,
    }
}

/// Report a failure under `context`, keeping `Unsupported` distinguishable so
/// the host can tell a missing capability from a broken guest.
fn init_error(context: &str, error: &BoxliteError) -> ContainerInitError {
    let kind = match error {
        BoxliteError::Unsupported(_) => ContainerInitErrorKind::Unsupported,
        _ => ContainerInitErrorKind::Internal,
    };
    ContainerInitError {
        reason: format!("{context}: {error}"),
        kind: kind as i32,
    }
}

/// Check a `Container.Mount` request: read-only, a source that is one share
/// folder name so it stays inside `containers/<id>/volumes/`, and a valid
/// container path. Returns the destination.
#[allow(clippy::result_large_err)]
fn checked_mount(request: &ContainerMountRequest) -> Result<PathBuf, Status> {
    if !request.read_only {
        return Err(Status::invalid_argument(
            "Container.Mount mounts share folders read-only",
        ));
    }
    let one_component = matches!(
        Path::new(&request.source).components().collect::<Vec<_>>()[..],
        [Component::Normal(_)]
    );
    if !one_component {
        return Err(Status::invalid_argument(format!(
            "source must be one share folder name, not a path: {:?}",
            request.source
        )));
    }
    let destination = PathBuf::from(&request.destination);
    validate_destination(&destination).map_err(BoxliteError::into_validation_status)?;
    Ok(destination)
}

/// Report a failed attach: caller mistakes stay `INVALID_ARGUMENT`; a
/// non-empty destination, or init exiting since the running check, is
/// `FAILED_PRECONDITION`; anything else is `INTERNAL`.
fn mount_status(error: BoxliteError) -> Status {
    match error {
        BoxliteError::InvalidArgument(message) => Status::invalid_argument(message),
        BoxliteError::InvalidState(message) | BoxliteError::NotFound(message) => {
            Status::failed_precondition(message)
        }
        error => Status::internal(error.to_string()),
    }
}

/// Prepare container rootfs based on the initialization strategy.
///
/// Handles three strategies:
/// - Merged: Shared rootfs already exists (no-op)
/// - Overlay: Bind-mount layers to diff dir, create overlayfs
/// - Disk: Mount block device to shared rootfs
fn prepare_rootfs(
    rootfs_init: &RootfsInit,
    container_id: &str,
    shared_rootfs: &Path,
    layout: &GuestLayout,
) -> Result<(), String> {
    match &rootfs_init.strategy {
        Some(rootfs_init::Strategy::Merged(_)) => {
            info!("Rootfs strategy: merged (using shared rootfs)");
            // Shared rootfs already exists, nothing to do
            Ok(())
        }
        Some(rootfs_init::Strategy::Overlay(overlay)) => {
            info!(
                "Rootfs strategy: overlay ({} layers, copy={})",
                overlay.layer_names.len(),
                overlay.copy_layers
            );

            // Bind-mount layers from convention-based path to container's diff dir
            let container_layout = layout.shared().container(container_id);
            let layers_source = container_layout.layers_dir();
            let diff_dir = container_layout.diff_dir();

            std::fs::create_dir_all(&diff_dir)
                .map_err(|e| format!("Failed to create diff dir: {}", e))?;

            mount(
                Some(layers_source.as_path()),
                &diff_dir,
                None::<&str>,
                MsFlags::MS_BIND,
                None::<&str>,
            )
            .map_err(|e| format!("Failed to bind-mount layers to diff: {}", e))?;

            // TODO: Create overlayfs and mount to shared_rootfs
            Ok(())
        }
        Some(rootfs_init::Strategy::Disk(disk)) => {
            info!("Rootfs strategy: disk (device={})", disk.device);

            std::fs::create_dir_all(shared_rootfs)
                .map_err(|e| format!("Failed to create shared rootfs directory: {}", e))?;

            // Mount container rootfs disk with options from host
            BlockDeviceMount::mount(
                Path::new(&disk.device),
                shared_rootfs,
                Filesystem::Ext4,
                disk.need_format,
                disk.need_resize,
            )
            .map_err(|e| format!("Failed to mount rootfs disk: {}", e))?;

            Ok(())
        }
        None => Err("Missing rootfs strategy in Container.Init request".to_string()),
    }
}

#[tonic::async_trait]
impl ContainerService for GuestServer {
    async fn init(
        &self,
        request: Request<ContainerInitRequest>,
    ) -> Result<Response<ContainerInitResponse>, Status> {
        let init_req = request.into_inner();
        info!("Received container init request");

        // Get container ID from request (generated by host)
        let container_id = init_req.container_id.clone();
        if container_id.is_empty() {
            error!("Missing container_id in Init request");
            return Ok(Response::new(ContainerInitResponse {
                result: Some(container_init_response::Result::Error(internal_init_error(
                    "Missing container_id in Init request",
                ))),
            }));
        }

        // Session id to register the init process under, assigned by the host
        // (= container_id). The guest does not derive it: whoever names the
        // session owns the convention, and that is the side that later attaches
        // to it.
        let init_execution_id = init_req.execution_id.clone();
        if init_execution_id.is_empty() {
            error!("Missing execution_id in Init request");
            return Ok(Response::new(ContainerInitResponse {
                result: Some(container_init_response::Result::Error(internal_init_error(
                    "Missing execution_id in Init request",
                ))),
            }));
        }
        // Check if guest is initialized
        {
            let init_state = self.init_state.lock().await;
            if !init_state.initialized {
                error!("Guest not initialized (Guest.Init must be called first)");
                return Ok(Response::new(ContainerInitResponse {
                    result: Some(container_init_response::Result::Error(internal_init_error(
                        "Guest not initialized (Guest.Init must be called first)",
                    ))),
                }));
            }
        }

        // Resolve device nodes now: this reads the guest's own /dev, and must
        // fail before rootfs or bundle setup performs side effects.
        let devices = match ContainerDevices::from_proto(init_req.devices) {
            Ok(devices) => devices,
            Err(error) => {
                error!("Invalid container device mapping: {error}");
                return Ok(Response::new(ContainerInitResponse {
                    result: Some(container_init_response::Result::Error(init_error(
                        "Invalid container device mapping",
                        &error,
                    ))),
                }));
            }
        };

        // Extract container config
        let config = init_req
            .container_config
            .ok_or_else(|| Status::invalid_argument("Missing container_config in Init request"))?;

        // Validate configuration
        if config.entrypoint.is_empty() {
            error!("Invalid container config: entrypoint cannot be empty");
            return Ok(Response::new(ContainerInitResponse {
                result: Some(container_init_response::Result::Error(internal_init_error(
                    "Invalid container config: entrypoint cannot be empty",
                ))),
            }));
        }

        // Validate before resolving capabilities: an unsupported destination
        // or empty options means either a host/guest version mismatch or a
        // mount this guest doesn't know how to override (see
        // container::mount_override), and capability resolution needs a
        // live /proc read this box shouldn't pay for on a request we're
        // about to reject anyway. The host has already expanded high-level
        // security options into atomic OCI choices; capabilities are the one
        // piece the guest still resolves itself, against its own kernel.
        let advanced = config.advanced.unwrap_or_default();
        let mount_options = advanced.mount.unwrap_or_default();
        let mount_override = MountOverride {
            source: mount_options.source,
            options: mount_options.options,
        };
        validate_mount_override(&mount_options.destination, &mount_override)
            .map_err(BoxliteError::into_validation_status)?;
        let capability_policy = advanced.capabilities.unwrap_or_default();
        let capabilities = CapabilitySet::resolve(&capability_policy.add, &capability_policy.drop)
            .map_err(BoxliteError::into_validation_status)?;
        let readonly_paths = advanced.linux.unwrap_or_default().readonly_paths;

        info!("🚀 Starting OCI container with received configuration");

        // Compute rootfs paths from container_id
        // Shared rootfs: /run/boxlite/shared/containers/{cid}/rootfs
        // Bundle rootfs: /run/boxlite/containers/{cid}/rootfs (OCI bundle)
        let shared_rootfs = self.layout.shared().container(&container_id).rootfs_dir();
        let bundle_rootfs = self
            .layout
            .container_bundle_dir(&container_id)
            .join("rootfs");

        // Create bundle rootfs directory
        if let Err(e) = std::fs::create_dir_all(&bundle_rootfs) {
            error!("Failed to create bundle rootfs directory: {}", e);
            return Ok(Response::new(ContainerInitResponse {
                result: Some(container_init_response::Result::Error(internal_init_error(
                    format!("Failed to create bundle rootfs directory: {}", e),
                ))),
            }));
        }

        // Handle rootfs initialization based on strategy
        let rootfs_init = init_req
            .rootfs
            .ok_or_else(|| Status::invalid_argument("Missing rootfs in Container.Init request"))?;

        if let Err(reason) =
            prepare_rootfs(&rootfs_init, &container_id, &shared_rootfs, &self.layout)
        {
            error!("{}", reason);
            return Ok(Response::new(ContainerInitResponse {
                result: Some(container_init_response::Result::Error(internal_init_error(
                    reason,
                ))),
            }));
        }

        // Bind mount shared rootfs to bundle rootfs
        if let Err(e) = mount(
            Some(shared_rootfs.as_path()),
            &bundle_rootfs,
            None::<&str>,
            MsFlags::MS_BIND,
            None::<&str>,
        ) {
            error!("Failed to bind mount rootfs: {}", e);
            return Ok(Response::new(ContainerInitResponse {
                result: Some(container_init_response::Result::Error(internal_init_error(
                    format!("Failed to bind mount rootfs: {}", e),
                ))),
            }));
        }

        // Install CA certs into container trust store (from gRPC CACert field).
        if !init_req.ca_certs.is_empty() {
            let bundle = bundle_rootfs.join("etc/ssl/certs/ca-certificates.crt");
            let installer = crate::ca_trust::CaInstaller::with_bundle(bundle);
            let mut installed = 0;
            for ca in &init_req.ca_certs {
                match installer.install(ca.pem.as_bytes()) {
                    Ok(()) => installed += 1,
                    Err(e) => warn!("Failed to install CA cert: {e}"),
                }
            }
            if installed > 0 {
                info!(count = installed, "CA certs installed in container");
            } else {
                error!(
                    total = init_req.ca_certs.len(),
                    "All CA cert installations failed — HTTPS will not trust MITM proxy"
                );
            }
        }

        // Convert proto BindMount to UserMount for OCI spec. Each source is the
        // container's volume folder in the share: <shared>/containers/{id}/volumes/{name}
        let container_layout = self.layout.shared().container(&container_id);

        let user_mounts: Vec<UserMount> = init_req
            .mounts
            .iter()
            .map(|m| {
                let volume_dir = container_layout.volume_dir(&m.volume_name);
                // Single-file mount: bind just the one file within the shared dir.
                let source = if m.subpath.is_empty() {
                    volume_dir
                } else {
                    volume_dir.join(&m.subpath)
                };
                UserMount {
                    source: source.to_string_lossy().to_string(),
                    destination: m.destination.clone(),
                    read_only: m.read_only,
                    owner_uid: m.owner_uid,
                    owner_gid: m.owner_gid,
                }
            })
            .collect();

        debug!(
            entrypoint = ?config.entrypoint,
            workdir = %config.workdir,
            env_count = config.env.len(),
            shared_rootfs = %shared_rootfs.display(),
            bundle_rootfs = %bundle_rootfs.display(),
            container_id = %container_id,
            user_mounts_count = user_mounts.len(),
            device_count = devices.len(),
            "Container configuration"
        );

        // A new container run starts here, so drop the exit file the
        // previous run left behind. The file is per-run state: a box that is
        // stopped and started again must not inherit the exit its last init
        // died with, or the guard in Exec would refuse every exec against the
        // freshly running container ("container is not running: init exited").
        let exit_file = self.layout.shared().container(&container_id).exit_file();
        if let Err(e) = std::fs::remove_file(&exit_file) {
            if e.kind() != std::io::ErrorKind::NotFound {
                error!("Failed to clear stale exit file: {}", e);
                return Ok(Response::new(ContainerInitResponse {
                    result: Some(container_init_response::Result::Error(internal_init_error(
                        format!("Failed to clear stale exit file: {}", e),
                    ))),
                }));
            }
        }

        // Start container using OCI bundle rootfs. Init is the box's main
        // command (docker semantics) and may exit on its own; its stdio is
        // pipe-based so the session registered below can stream it, and the
        // guest holds the stdin write-end until a client attaches.
        debug!(
            container_id = %container_id,
            entrypoint = ?config.entrypoint,
            "Starting OCI container with pipe-based stdio"
        );
        match Container::start(
            &container_id,
            &bundle_rootfs,
            config.entrypoint,
            config.env,
            &config.workdir,
            &config.user,
            user_mounts,
            config.tty,
            capabilities,
            readonly_paths,
            mount_override,
            devices,
        ) {
            Ok(mut container) => {
                // Init is created, not yet running — Init never runs it; the
                // host calls Container.Start for that. That its pid and stdio
                // exist already is what lets the session below be registered
                // against it, and a client attach to it, before it runs.
                debug!(container_id = %container_id, "Container created");

                info!(
                    container_id = %container_id,
                    "✅ Container started successfully and ready for exec"
                );

                // Expose init as an attachable exec session under the
                // host-assigned execution_id: the host's `run` attaches to it
                // exactly like any exec (Attach/SendInput/Wait RPCs).
                //
                // Failing to register is fatal, not a warning. Without the
                // session there is nothing to attach to and no exit action, so
                // the box would sit Running behind a main command nobody can
                // see or reap — precisely the bug this whole path exists to
                // kill. A container we cannot address is not a started
                // container.
                let init_exit = match container.take_init_exec_handle() {
                    Ok(Some(handle)) => {
                        let process =
                            crate::service::exec::process_instance::ProcessInstance::capture(
                                handle.pid(),
                            );
                        if process.is_none() {
                            warn!(
                                container_id = %container_id,
                                pid = handle.pid().as_raw(),
                                "failed to capture init process identity; signals will be skipped"
                            );
                        }
                        // Register init's exit slot and the follow-up the reaper
                        // fires on delivery (docker semantics: the box
                        // stops when init exits). Init is created but not yet
                        // started here — it blocks on libcontainer's exec fifo —
                        // so it cannot have exited, and `now` is a sound cutoff:
                        // any slot already under this pid is a recycled-pid
                        // leftover.
                        let registry = self.registry.clone();
                        let shutting_down = self.shutting_down.clone();
                        let exit_file = self.layout.shared().container(&container_id).exit_file();
                        let cid = container_id.clone();
                        let action: crate::reaper::ExitAction = Box::new(move |status| {
                            // The reaper only fires this; the long work runs on
                            // its own task.
                            tokio::spawn(async move {
                                let exit_code = status.shell_code();
                                info!(container_id = %cid, ?status, exit_code, "container init exited");

                                // Crosses the virtiofs shared dir to the host,
                                // which reads it to surface the box's exit
                                // status. The Shutdown RPC writes the same
                                // record from the same slot, so a host-driven
                                // stop does not depend on this task's timing.
                                let record = boxlite_shared::layout::ExitRecord { exit_code };
                                if let Err(e) = record.write(&exit_file) {
                                    warn!(container_id = %cid, error = %e, "failed to write exit file");
                                }

                                if shutting_down.load(std::sync::atomic::Ordering::SeqCst) {
                                    return; // host-driven stop owns VM teardown
                                }

                                // Drain the execs still running beside init,
                                // flush disks, then power off. The shim sees the
                                // VM exit and the host marks the box stopped.
                                registry
                                    .shutdown_all(
                                        crate::service::exec::registry::SHUTDOWN_TIMEOUT_MS,
                                    )
                                    .await;
                                unsafe { nix::libc::sync() };

                                // A best-effort flush window for whatever output
                                // is still in flight to the host — and nothing
                                // more than that.
                                //
                                // It is not load-bearing, and that claim now
                                // survives inspection, which it did not before:
                                //
                                // - The client is *already attached* when the
                                //   main command runs. The host creates the
                                //   container, attaches, and only then calls
                                //   Container.Start (docker's create → attach →
                                //   start). So no client can miss the session by
                                //   being late — the race this window used to be
                                //   papering over is gone by construction, not
                                //   by timing.
                                // - The exit code is durable. Power-off can
                                //   still cut the in-flight Wait, and the host
                                //   then has no code — but it reads the real one
                                //   back from the exit file written above
                                //   (`BoxImpl::exit_code_from_file_when_portal_has_none`).
                                //
                                // What is left is trailing stdout, whose
                                // delivery has no event to await: the protocol
                                // carries no ack, so the guest can never know
                                // the host received the last bytes. A bounded
                                // window is the only thing available, and it is
                                // spent on output, not on truth.
                                const RESPONSE_FLUSH_MS: u64 = 500;
                                tokio::time::sleep(std::time::Duration::from_millis(
                                    RESPONSE_FLUSH_MS,
                                ))
                                .await;
                                info!(container_id = %cid, "powering off VM (init exited)");
                                // RESTART, not POWER_OFF. The x86_64 microVM
                                // kernel has no pm_power_off backend (no
                                // ACPI), so POWER_OFF degrades to "System
                                // halted" with the VM left running forever —
                                // the box never stops. RESTART is the one
                                // command every backend turns into a VMM
                                // process exit: the kernel's reboot=k path
                                // ends in an i8042 CPU reset on x86, and a
                                // PSCI SYSTEM_RESET on aarch64, both trapped
                                // as a shutdown. It is also exactly what the
                                // VMM's own bundled init issues when its
                                // workload exits.
                                unsafe {
                                    nix::libc::reboot(nix::libc::LINUX_REBOOT_CMD_RESTART);
                                }
                            });
                        });
                        let reaper = crate::reaper::REAPER
                            .get()
                            .expect("reaper installed at startup");
                        let exit = reaper
                            .on_exit(handle.pid(), std::time::Instant::now(), action)
                            .await;
                        let state = crate::service::exec::state::ExecutionState::new_init_session(
                            handle,
                            exit.clone(),
                            process,
                        );
                        if !self
                            .registry
                            .register(init_execution_id.clone(), state.clone())
                            .await
                        {
                            state.abort_unpublished().await;
                            // Init's session is not shutdown-managed, so the
                            // teardown above leaves the slot — and the power-off
                            // action parked on it — in place.
                            reaper.release_slot(&exit);
                            return Ok(Response::new(ContainerInitResponse {
                                result: Some(container_init_response::Result::Error(
                                    internal_init_error(
                                        "Execution registry is shutting down or already owns the init session",
                                    ),
                                )),
                            }));
                        }
                        exit
                    }
                    Ok(None) => {
                        error!(container_id = %container_id, "init has no pid or its stdio was already taken");
                        return Ok(Response::new(ContainerInitResponse {
                            result: Some(container_init_response::Result::Error(
                                internal_init_error(
                                    "Container started but its init process could not be \
                                     exposed as a session (no pid or stdio)",
                                ),
                            )),
                        }));
                    }
                    Err(e) => {
                        error!(container_id = %container_id, error = %e, "failed to build init session");
                        return Ok(Response::new(ContainerInitResponse {
                            result: Some(container_init_response::Result::Error(
                                internal_init_error(format!(
                                    "Failed to build the init session: {}",
                                    e
                                )),
                            )),
                        }));
                    }
                };

                // Store container in registry
                self.containers.lock().await.insert(
                    container_id.clone(),
                    std::sync::Arc::new(tokio::sync::Mutex::new(container)),
                );

                // The Shutdown RPC reads this slot to write the exit record
                // itself before answering the host — the reaper's action may
                // still be running on its own task when that RPC returns.
                self.init_exits
                    .lock()
                    .await
                    .insert(container_id.clone(), init_exit);

                // Restore is owned by a task so cancellation cannot release its
                // serialization lock while storage work is still running.
                if let Some(guest) = self.ssh_manager.guest() {
                    let root = shared_rootfs.clone();
                    let result =
                        tokio::spawn(async move { guest.ssh_manager.restore(root).await }).await;
                    match result {
                        Ok(Ok(())) => {}
                        Ok(Err(error)) => tracing::warn!(
                            %container_id,
                            %error,
                            "SSH state could not be restored"
                        ),
                        Err(error) => tracing::warn!(
                            %container_id,
                            reason = if error.is_panic() { "panic" } else { "cancelled" },
                            "SSH state restore task failed"
                        ),
                    }
                }

                // Everything that must exist *before* the main command runs now
                // does — the session is registered and the exit action is armed —
                // and init has *not* run. The host calls Container.Start to run it,
                // after attaching if it wants to.
                Ok(Response::new(ContainerInitResponse {
                    result: Some(container_init_response::Result::Success(
                        ContainerInitSuccess { container_id },
                    )),
                }))
            }
            // The caller's input, such as a command the image cannot run, not a
            // guest failure: answer it like the validation above, which the
            // host maps to a bare InvalidArgument.
            Err(e @ BoxliteError::InvalidArgument(_)) => {
                error!("Failed to create container: {}", e);
                Err(e.into_validation_status())
            }
            Err(e) => {
                error!("Failed to create container: {}", e);
                Ok(Response::new(ContainerInitResponse {
                    result: Some(container_init_response::Result::Error(init_error(
                        "Failed to create container",
                        &e,
                    ))),
                }))
            }
        }
    }

    async fn start(
        &self,
        request: Request<ContainerStartRequest>,
    ) -> Result<Response<ContainerStartResponse>, Status> {
        let container_id = request.into_inner().container_id;
        if container_id.is_empty() {
            return Err(Status::invalid_argument(
                "Missing container_id in Start request",
            ));
        }

        match self.run_container_init(&container_id).await {
            Ok(()) => Ok(Response::new(ContainerStartResponse {
                result: Some(container_start_response::Result::Success(
                    ContainerStartSuccess { container_id },
                )),
            })),
            Err(reason) => Ok(Response::new(ContainerStartResponse {
                result: Some(container_start_response::Result::Error(
                    internal_init_error(reason),
                )),
            })),
        }
    }

    async fn mount(
        &self,
        request: Request<ContainerMountRequest>,
    ) -> Result<Response<ContainerMountResponse>, Status> {
        let request = request.into_inner();
        let destination = checked_mount(&request)?;

        let container_id = request.container_id;
        let Some(container_arc) = self.containers.lock().await.get(&container_id).cloned() else {
            return Err(Status::not_found(format!(
                "No such container: {container_id}"
            )));
        };
        let mut container = container_arc.lock().await;
        let target = container
            .init_pid()
            .filter(|_| container.is_running())
            .ok_or_else(|| {
                Status::failed_precondition(format!("container {container_id} is not running"))
            })?;
        let spec = AttachSpec {
            source: self
                .layout
                .shared()
                .container(&container_id)
                .volume_dir(&request.source),
            target_pid: target.as_raw(),
            destination: destination.clone(),
        };
        let zygote = ZYGOTE.get().expect("zygote not started");
        tokio::task::spawn_blocking(move || zygote.attach_mount(spec))
            .await
            .map_err(|error| Status::internal(format!("attach task failed: {error}")))?
            .map_err(mount_status)?;
        info!(container_id = %container_id, destination = %destination.display(), "Mounted a share folder read-only");
        container.record_mount_destination(destination);
        Ok(Response::new(ContainerMountResponse {}))
    }
}

impl GuestServer {
    /// Run a created container's init process. Reached only via the
    /// `Container.Start` RPC — `Container.Init` creates the container and stops.
    ///
    /// It deliberately does **not** check that init survived the start. Under
    /// docker semantics init *is* the user's command, and a command that finishes
    /// immediately is the most ordinary thing in the world — `run alpine true`.
    /// The old check called that a failure, and only passed because reading
    /// procfs usually beat init's `execvp`; it was a bet, of exactly the kind the
    /// attach-before-start ordering exists to remove. A genuinely broken command
    /// still surfaces, and more precisely than before: the exit action records
    /// its code (127 for not-found, 126 for not-executable), the box stops with
    /// it, and the client that is already attached sees whatever it printed.
    async fn run_container_init(&self, container_id: &str) -> Result<(), String> {
        let containers = self.containers.lock().await;
        let Some(container_arc) = containers.get(container_id).cloned() else {
            return Err(format!("No such container: {}", container_id));
        };
        drop(containers);

        let container = container_arc.lock().await;
        if let Err(e) = container.run_init() {
            error!(container_id = %container_id, error = %e, "Failed to start container");
            return Err(format!("Failed to start container: {}", e));
        }

        info!(container_id = %container_id, "✅ Container started successfully and ready for exec");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tonic::Code;

    fn share_folder(source: &str, destination: &str) -> ContainerMountRequest {
        ContainerMountRequest {
            container_id: "box".to_string(),
            source: source.to_string(),
            destination: destination.to_string(),
            read_only: true,
        }
    }

    #[test]
    fn mount_accepts_a_read_only_share_folder() {
        let destination = checked_mount(&share_folder("agents", "/opt/boxlite/agents")).unwrap();
        assert_eq!(destination, PathBuf::from("/opt/boxlite/agents"));
    }

    #[test]
    fn mount_keeps_the_source_inside_one_share_folder() {
        for source in ["..", "a/b", "", ".", "/agents"] {
            let status =
                checked_mount(&share_folder(source, "/opt/boxlite/agents")).expect_err(source);
            assert_eq!(status.code(), Code::InvalidArgument, "{source:?}");
        }
    }

    #[test]
    fn mount_refuses_writable_or_misplaced_mounts() {
        let writable = ContainerMountRequest {
            read_only: false,
            ..share_folder("agents", "/opt/boxlite/agents")
        };
        let relative = share_folder("agents", "opt/boxlite/agents");
        for request in [writable, relative] {
            let status = checked_mount(&request).unwrap_err();
            assert_eq!(status.code(), Code::InvalidArgument, "{}", status.message());
        }
    }

    #[test]
    fn attach_failures_keep_their_grpc_codes() {
        let cases = [
            (
                BoxliteError::InvalidArgument("bad".into()),
                Code::InvalidArgument,
            ),
            (
                BoxliteError::InvalidState("has entries".into()),
                Code::FailedPrecondition,
            ),
            (
                BoxliteError::NotFound("init gone".into()),
                Code::FailedPrecondition,
            ),
            (BoxliteError::Storage("move_mount".into()), Code::Internal),
        ];
        for (error, code) in cases {
            assert_eq!(mount_status(error).code(), code);
        }
    }
}
