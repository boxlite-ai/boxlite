// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The VM facade: configuration, host VM creation, RAM registration, boot
//! loading, and running the vCPUs until the VM ends.

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};

use boxlite_hypervisor::Vm as HostVm;

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
use crate::snapshot::{export, restore, state::MachineState};
use crate::{
    chipset::{Chipset, ChipsetBuilder},
    config::VmConfig,
    control::{ControlRegistry, VmControl},
    devices::console::ConsoleWorker,
    error::{Error, Result},
    events::{EventLoop, EventSender},
    lifecycle::Lifecycle,
    memory::{GuestRam, ram_ranges},
    virtio::{
        DeviceContext,
        worker::{ShutdownError, VirtioWorkers},
    },
};

/// The registers the boot vCPU starts with.
#[cfg(target_arch = "x86_64")]
pub(crate) type BootRegisters = boxlite_hypervisor::X86BootRegisters;
/// arm64 boot registers arrive with the arm64 boot path.
#[cfg(not(target_arch = "x86_64"))]
pub(crate) type BootRegisters = ();

/// How a VM ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum VmExit {
    /// A control handle stopped it.
    StopRequested,
    /// The guest powered off.
    GuestShutdown,
    /// The guest reset; the VMM never restarts it.
    GuestReset,
}

/// Requests a stop from any thread. [`Vm::run`] returns
/// [`VmExit::StopRequested`] if the stop request is the first terminal event.
#[derive(Clone, Debug)]
pub struct StopHandle(Arc<Lifecycle>);

impl StopHandle {
    /// Asks the VM to stop and returns without waiting.
    pub fn stop(&self) {
        self.0.stop();
    }
}

/// The guest machine on host backend `H`.
pub struct Vm<H: HostVm> {
    // Devices drop before the host VM, and the host VM drops before the RAM.
    // `Drop` can take these fields to close a fresh VM before releasing RAM.
    chipset: Option<Chipset>,
    /// Runs every virtio device's events on one thread; `run` and `Drop` shut
    /// them down before the RAM is released.
    workers: Option<VirtioWorkers>,
    /// The worker writing the guest console to the caller's sink; `run`
    /// finishes it once every vCPU has stopped. The lock only makes `Vm`
    /// `Sync`; `run` reaches it through `&mut self`.
    console: Mutex<Option<ConsoleWorker>>,
    control: VmControl,
    events: Mutex<EventLoop>,
    sender: EventSender,
    boot_regs: BootRegisters,
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    restore: Option<Box<MachineState>>,
    vcpu_count: u8,
    lifecycle: Arc<Lifecycle>,
    fresh_vm: bool,
    host_vm: Option<Arc<H>>,
    ram: GuestRam,
}

impl<H: HostVm> std::fmt::Debug for Vm<H> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (vcpus, state) = (self.vcpu_count, self.lifecycle.status());
        f.debug_struct("Vm")
            .field("vcpus", &vcpus)
            .field("state", &state)
            .finish_non_exhaustive()
    }
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
impl Vm<boxlite_hypervisor::KvmVm> {
    /// Imports the state and RAM files of a device-less snapshot into a VM in `Created`.
    /// Call [`Self::run`] to install saved CPU and platform state and execute it.
    /// Reserve a pause through [`Self::control`] before running to hold guest entry.
    pub fn from_state(state_path: impl AsRef<Path>, memory_path: impl AsRef<Path>) -> Result<Self> {
        restore::from_paths(state_path.as_ref(), memory_path.as_ref())
    }

    /// Builds a KVM VM with an empty chipset and no console worker.
    /// Rejects userspace device configuration before opening KVM.
    #[cfg(all(test, target_os = "linux", target_arch = "x86_64"))]
    pub(crate) fn new_device_less(config: VmConfig) -> Result<Self> {
        use crate::boot;

        config.validate_device_less()?;
        let prepared = boxlite_hypervisor::KvmVm::prepare()?;
        let (leaf, _) = boot::preflight(&config, &prepared)?;
        let vm = Self::build(
            config,
            move || boxlite_hypervisor::KvmVm::from_prepared(prepared),
            true,
            VirtioWorkers::new,
            move |ram, config| boot::prepare(ram, config, leaf).map(|setup| setup.boot_regs),
            |_, _, _, _| Ok(()),
        )?;
        debug_assert!(vm.chipset.as_ref().is_some_and(Chipset::is_empty));
        Ok(vm)
    }

    /// Validates `config` and preflights the boot layout and any hotplug window
    /// against KVM before spawning the console worker and building the VM.
    /// `devices::add_all` adds the legacy devices and one virtio-blk device
    /// per disk, taking each disk's virtio-mmio slot and naming it on the
    /// command line; `config.cmdline` must leave room for those arguments,
    /// about 35 bytes each, under `config::MAX_CMDLINE_BYTES`. The guest's
    /// COM1 output goes to `console` through a queue, so a slow sink never
    /// stalls the guest.
    pub fn new(config: VmConfig, console: Box<dyn std::io::Write + Send>) -> Result<Self> {
        use crate::{boot, devices::console::DEFAULT_QUEUE_BYTES};

        config.validate()?;
        let prepared = boxlite_hypervisor::KvmVm::prepare()?;
        let (leaf, hotplug_window) = boot::preflight(&config, &prepared)?;
        let (writer, worker) =
            ConsoleWorker::spawn(console, DEFAULT_QUEUE_BYTES).map_err(Error::SpawnConsole)?;
        let mut vm = Self::build(
            config,
            move || boxlite_hypervisor::KvmVm::from_prepared(prepared),
            true,
            VirtioWorkers::new,
            move |ram, config| boot::prepare(ram, config, leaf).map(|setup| setup.boot_regs),
            |chipset, ctx, config, host_vm| {
                crate::devices::add_all(chipset, ctx, config, writer, host_vm, hotplug_window)
            },
        )?;
        vm.console = Mutex::new(Some(worker));
        Ok(vm)
    }
}

impl<H: HostVm> Vm<H> {
    /// The low-level constructor tests use: like [`Self::with_devices`],
    /// without the mutable configuration.
    #[cfg(test)]
    pub(crate) fn with_backend(
        config: VmConfig,
        host_vm: impl FnOnce() -> boxlite_hypervisor::Result<H>,
        boot: impl FnOnce(&GuestRam, &VmConfig) -> Result<BootRegisters>,
        devices: impl FnOnce(&mut ChipsetBuilder, DeviceContext<'_>) -> Result<()>,
    ) -> Result<Self>
    where
        H: 'static,
    {
        Self::with_devices(config, host_vm, boot, |chipset, ctx, _, _| {
            devices(chipset, ctx)
        })
    }

    #[cfg(test)]
    pub(crate) fn with_devices(
        config: VmConfig,
        host_vm: impl FnOnce() -> boxlite_hypervisor::Result<H>,
        boot: impl FnOnce(&GuestRam, &VmConfig) -> Result<BootRegisters>,
        devices: impl FnOnce(
            &mut ChipsetBuilder,
            DeviceContext<'_>,
            &mut VmConfig,
            &Arc<H>,
        ) -> Result<()>,
    ) -> Result<Self>
    where
        H: 'static,
    {
        Self::build(config, host_vm, false, VirtioWorkers::new, boot, devices)
    }

    /// Validates `config`, allocates the RAM layout, creates the host VM with
    /// `host_vm`, builds the chipset from the devices `devices` adds,
    /// registers every RAM range and writes the boot data with `boot`.
    /// `devices` also gets the guest memory, the virtio workers, the mutable
    /// configuration and the host VM. Invalid configuration fails before `host_vm`
    /// runs, and a chipset conflict before any RAM is registered.
    /// `fresh_vm` requires a newly created VM with no independent vCPUs.
    #[cfg_attr(
        not(any(test, all(target_os = "linux", target_arch = "x86_64"))),
        expect(
            dead_code,
            reason = "Only the Linux x86_64 Vm::new composes devices yet."
        )
    )]
    fn build(
        config: VmConfig,
        host_vm: impl FnOnce() -> boxlite_hypervisor::Result<H>,
        fresh_vm: bool,
        create_workers: impl FnOnce(EventSender) -> std::io::Result<VirtioWorkers>,
        boot: impl FnOnce(&GuestRam, &VmConfig) -> Result<BootRegisters>,
        devices: impl FnOnce(
            &mut ChipsetBuilder,
            DeviceContext<'_>,
            &mut VmConfig,
            &Arc<H>,
        ) -> Result<()>,
    ) -> Result<Self>
    where
        H: 'static,
    {
        let mut config = config;
        config.validate()?;
        let ram = GuestRam::new(&ram_ranges(config.memory_mib))?;
        let mut vm = Self::with_ram(
            ram,
            config.vcpu_count,
            host_vm,
            fresh_vm,
            create_workers,
            |chipset, ctx, host_vm| devices(chipset, ctx, &mut config, host_vm),
        )?;
        vm.boot_regs = boot(&vm.ram, &config)?;
        Ok(vm)
    }

    /// Builds a device-less VM around a validated image and a fresh host VM.
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    pub(crate) fn with_restored_ram(
        ram: GuestRam,
        machine: MachineState,
        create: impl FnOnce() -> boxlite_hypervisor::Result<H>,
    ) -> Result<Self>
    where
        H: 'static,
    {
        let mut vm = Self::with_ram(
            ram,
            machine.vcpus.len() as u8,
            create,
            true,
            VirtioWorkers::new,
            |_, _, _| Ok(()),
        )?;
        vm.restore = Some(Box::new(machine));
        Ok(vm)
    }

    /// Builds the chipset and registers the supplied RAM before the first run.
    fn with_ram(
        mut ram: GuestRam,
        vcpu_count: u8,
        host_vm: impl FnOnce() -> boxlite_hypervisor::Result<H>,
        fresh_vm: bool,
        create_workers: impl FnOnce(EventSender) -> std::io::Result<VirtioWorkers>,
        devices: impl FnOnce(&mut ChipsetBuilder, DeviceContext<'_>, &Arc<H>) -> Result<()>,
    ) -> Result<Self>
    where
        H: 'static,
    {
        let events = EventLoop::new().map_err(Error::EventLoop)?;
        let sender = events.sender();
        let host_vm = Arc::new(host_vm()?);
        // No worker thread starts before a virtio device activates, so an
        // early return leaves nothing running.
        let workers = create_workers(sender.clone()).map_err(Error::VirtioWorker)?;
        let mut chipset = ChipsetBuilder::new(host_vm.clone(), sender.clone());
        let mut controls = ControlRegistry::default();
        devices(
            &mut chipset,
            DeviceContext {
                memory: ram.memory(),
                workers: &workers,
                controls: &mut controls,
            },
            &host_vm,
        )?;
        let chipset = chipset.build()?;
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        let device_less = chipset.is_empty();
        // Public VM constructors and chipset inspection are Linux x86_64-only.
        #[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
        let device_less = false;
        if let Err(error) = ram.map(&*host_vm) {
            drop(chipset);
            drop(workers);
            if fresh_vm && let Some(host_vm) = Arc::into_inner(host_vm) {
                drop(host_vm);
                // SAFETY: The fresh host VM has closed and no vCPUs or virtio
                // workers have started.
                unsafe { ram.release_after_vm_close() };
            }
            return Err(error);
        }

        let lifecycle = Arc::new(Lifecycle::new(sender.clone(), device_less));
        Ok(Self {
            chipset: Some(chipset),
            workers: Some(workers),
            console: Mutex::new(None),
            events: Mutex::new(events),
            control: controls.finish(Arc::clone(&lifecycle)),
            lifecycle,
            sender,
            boot_regs: BootRegisters::default(),
            #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
            restore: None,
            vcpu_count,
            fresh_vm,
            host_vm: Some(host_vm),
            ram,
        })
    }

    /// A handle that stops this VM from another thread, even before
    /// [`run`](Self::run) starts.
    pub fn stop_handle(&self) -> StopHandle {
        StopHandle(Arc::clone(&self.lifecycle))
    }

    /// Controls the VM from another thread.
    pub fn control(&self) -> VmControl {
        self.control.clone()
    }

    #[cfg(all(test, target_os = "linux", target_arch = "x86_64"))]
    pub(crate) fn lifecycle(&self) -> &Arc<Lifecycle> {
        &self.lifecycle
    }
}

#[cfg(target_arch = "x86_64")]
impl<H: boxlite_hypervisor::X86Vm> Vm<H> {
    fn run_vcpus(&mut self) -> Result<VmExit> {
        use std::{
            io::ErrorKind,
            panic::{self, AssertUnwindSafe},
            thread,
            time::Duration,
        };

        use boxlite_hypervisor::VcpuHandle;

        use crate::{
            events::{Event, RECHECK},
            lifecycle::VmStatus,
            vcpu::{StartGate, Startup, Workers},
        };

        const KICK_RETRY: Duration = Duration::from_millis(10);

        fn retryable_kick(error: &boxlite_hypervisor::Error) -> bool {
            matches!(error, boxlite_hypervisor::Error::KickVcpu { source, .. }
                if matches!(source.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted))
        }

        let exit_from_event = |event| match event {
            Event::StopRequested => Ok(VmExit::StopRequested),
            Event::GuestShutdown => Ok(VmExit::GuestShutdown),
            Event::GuestReset => Ok(VmExit::GuestReset),
            Event::VcpuFailed(error) | Event::DeviceFailed(error) => Err(error),
        };
        let events = self
            .events
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner);
        let host_vm = self.host_vm.as_deref().expect("live VM has a host VM");
        let startup = Startup::Boot(&self.boot_regs);
        #[cfg(target_os = "linux")]
        let startup = self.restore.as_deref().map_or(startup, Startup::Restore);
        #[cfg(target_os = "linux")]
        if let Startup::Restore(machine) = startup
            && let Err(error) = install_platform(|| host_vm.restore_before_vcpus(&machine.platform))
        {
            self.sender.send(Event::VcpuFailed(error));
            let event = events
                .wait(Some(std::time::Duration::ZERO))
                .map_err(Error::EventLoop)?
                .expect("platform restore failure queued a terminal event");
            return exit_from_event(event);
        }

        self.fresh_vm = false;
        let gate = StartGate::default();
        let kicks = Mutex::new(Vec::new());
        let vcpus = Workers {
            host_vm,
            vcpu_count: self.vcpu_count,
            startup,
            chipset: self.chipset.as_ref().expect("live VM has a chipset"),
            sender: &self.sender,
            lifecycle: &self.lifecycle,
            kicks: &kicks,
            gate: &gate,
        };
        let event = thread::scope(|scope| {
            // Release workers before the scope joins them, including on unwind.
            struct StopVcpus<'a, H: VcpuHandle> {
                lifecycle: &'a Lifecycle,
                gate: &'a StartGate,
                kicks: &'a Mutex<Vec<H>>,
            }

            impl<H: VcpuHandle> Drop for StopVcpus<'_, H> {
                fn drop(&mut self) {
                    self.gate.abort();
                    self.lifecycle.mark_stopping();
                    // Late registrations cannot enter the guest after the stop latch.
                    let mut pending = std::mem::take(
                        &mut *self.kicks.lock().unwrap_or_else(PoisonError::into_inner),
                    );
                    while !pending.is_empty() {
                        pending.retain(|kick| {
                            match panic::catch_unwind(AssertUnwindSafe(|| kick.kick())) {
                                Ok(Ok(())) => {}
                                Ok(Err(error)) if retryable_kick(&error) => return true,
                                Ok(Err(error)) => tracing::warn!(%error, "failed to kick a vCPU"),
                                Err(_) => tracing::warn!("vCPU kick panicked during shutdown"),
                            }
                            false
                        });
                        if !pending.is_empty() {
                            thread::sleep(KICK_RETRY);
                        }
                    }
                }
            }

            let _stop = StopVcpus {
                lifecycle: &self.lifecycle,
                gate: &gate,
                kicks: &kicks,
            };
            for id in 0..vcpus.vcpu_count {
                let vcpus = &vcpus;
                let spawned = thread::Builder::new()
                    .name(format!("vcpu{id}"))
                    .spawn_scoped(scope, move || vcpus.run(id));
                if let Err(source) = spawned {
                    let vcpu = id.into();
                    vcpus
                        .sender
                        .send(Event::VcpuFailed(Error::SpawnVcpu { vcpu, source }));
                    gate.abort();
                    break;
                }
            }
            if gate.wait_ready(vcpus.vcpu_count) && !vcpus.sender.is_stopping() {
                let installed = match vcpus.startup {
                    Startup::Boot(_) => Ok(()),
                    #[cfg(target_os = "linux")]
                    Startup::Restore(machine) => {
                        install_platform(|| host_vm.restore_after_vcpus(&machine.platform))
                    }
                };
                match installed {
                    Ok(()) => gate.release(),
                    Err(error) => {
                        vcpus.sender.send(Event::VcpuFailed(error));
                        gate.abort();
                    }
                }
            }
            let mut pending_kicks = 0u64;
            loop {
                let wait = if pending_kicks != 0 {
                    KICK_RETRY
                } else {
                    RECHECK
                };
                match events.wait(Some(wait)) {
                    Ok(Some(event)) => break Ok(event),
                    Err(error) => break Err(Error::EventLoop(error)),
                    Ok(None) => {}
                }
                let kick_all = self.lifecycle.drive(self.vcpu_count);
                if kick_all || pending_kicks != 0 {
                    if self.lifecycle.status() != VmStatus::Pausing || vcpus.sender.is_stopping() {
                        pending_kicks = 0;
                    } else {
                        let kicks = kicks.lock().unwrap_or_else(PoisonError::into_inner);
                        // Startup only appends handles, so their indices stay stable.
                        for (index, kick) in kicks.iter().enumerate() {
                            let bit = 1u64 << index;
                            if !kick_all && pending_kicks & bit == 0 {
                                continue;
                            }
                            match kick.kick() {
                                Ok(()) => pending_kicks &= !bit,
                                Err(error) if retryable_kick(&error) => {
                                    pending_kicks |= bit;
                                }
                                Err(error) => {
                                    vcpus.sender.send(Event::VcpuFailed(error.into()));
                                    break;
                                }
                            }
                        }
                    }
                }
                #[cfg(target_os = "linux")]
                export::drive(vcpus.lifecycle, vcpus.host_vm, &self.ram, self.vcpu_count);
            }
        })?;
        exit_from_event(event)
    }

    /// Runs every vCPU on its own thread until the first event ends the VM,
    /// stops and joins them all, shuts the virtio workers down, and returns
    /// how the VM ended. Workers that do not shut down fail a run that
    /// otherwise ended cleanly. A VM runs once; a second call fails with
    /// [`Error::AlreadyRan`].
    pub fn run(&mut self) -> Result<VmExit> {
        let ended = if self.lifecycle.begin_run()? {
            self.run_vcpus()
        } else {
            Ok(VmExit::StopRequested)
        };

        // No vCPU notifies a queue any more. Stop the virtio devices before the
        // console finishes, so a device's last output still reaches the sink.
        self.control.close_memory();
        let workers = self.workers.as_ref().expect("live VM has virtio workers");
        let shutdown = workers.shutdown();
        let console = self
            .console
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(console) = console {
            console.finish();
            let dropped = console.dropped_bytes();
            if dropped > 0 {
                tracing::warn!(dropped, "dropped guest console output");
            }
        }
        if !matches!(&shutdown, Err(ShutdownError::Join(_))) {
            self.lifecycle.mark_exited();
        }
        // The error that ended the VM stays the one the caller sees.
        match (ended, shutdown.map_err(Error::from)) {
            (ended, Ok(())) => ended,
            (Ok(exit), Err(error)) => {
                tracing::warn!(?exit, "the VM ended, but virtio shutdown failed");
                Err(error)
            }
            (Err(ended), Err(error)) => {
                tracing::warn!(%error, "virtio shutdown failed");
                Err(ended)
            }
        }
    }
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn install_platform(restore: impl FnOnce() -> boxlite_hypervisor::Result<()>) -> Result<()> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(restore))
        .map_err(|_| Error::Snapshot(std::io::Error::other("platform restore panicked")))??;
    Ok(())
}

impl<H: HostVm> Drop for Vm<H> {
    fn drop(&mut self) {
        self.control.close_memory();
        // A device event that outlived the shutdown may still touch guest
        // RAM, so the registrations stay and `GuestRam` leaks the backing.
        let workers = self.workers.as_ref().expect("live VM has virtio workers");
        let shutdown = workers.shutdown();
        drop(
            self.console
                .get_mut()
                .unwrap_or_else(PoisonError::into_inner)
                .take(),
        );
        if let Err(ShutdownError::Join(error)) = shutdown {
            tracing::warn!(%error, "the virtio workers did not stop; leaking guest RAM");
            self.lifecycle.mark_exited();
            return;
        }
        // Quiesce failure after joining cannot leave a live callback.
        let host_vm = self.host_vm.as_deref().expect("live VM has a host VM");
        if let Err(error) = self.ram.unmap(host_vm) {
            tracing::warn!(
                %error,
                cause = ?std::error::Error::source(&error),
                "failed to unmap guest RAM"
            );
        }
        if self.fresh_vm {
            drop(self.chipset.take());
            drop(self.workers.take());
            let host_vm = self.host_vm.take().expect("live VM has a host VM");
            if let Some(host_vm) = Arc::into_inner(host_vm) {
                drop(host_vm);
                // SAFETY: The fresh host VM has closed, no vCPUs started,
                // and the virtio workers have stopped.
                unsafe { self.ram.release_after_vm_close() };
            }
        }
        self.lifecycle.mark_exited();
    }
}

// The file lives under `tests/` so the suite stays out of the crate's counted
// source; it is still a unit-test module with access to crate-private items.
#[cfg(test)]
#[path = "../tests/vm/mod.rs"]
mod tests;

#[cfg(all(test, target_arch = "x86_64"))]
#[path = "../tests/control/mod.rs"]
mod control_tests;
