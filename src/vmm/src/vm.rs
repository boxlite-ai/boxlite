// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The VM facade: configuration, host VM creation, RAM registration, boot
//! loading, and running the vCPUs until the VM ends.

use std::sync::{Arc, Mutex};

use boxlite_hypervisor::Vm as HostVm;

use crate::{
    chipset::{Chipset, ChipsetBuilder},
    config::VmConfig,
    control::{ControlRegistry, VmControl},
    devices::console::ConsoleWorker,
    error::{Error, Result},
    events::{Event, EventLoop, EventSender},
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
    /// A [`StopHandle`] stopped it.
    StopRequested,
    /// The guest powered off.
    GuestShutdown,
    /// The guest reset; the VMM never restarts it.
    GuestReset,
}

/// Stops a VM from any thread; [`Vm::run`] then returns
/// [`VmExit::StopRequested`] unless the VM had already ended.
#[derive(Clone, Debug)]
pub struct StopHandle(EventSender);

impl StopHandle {
    /// Asks the VM to stop and returns without waiting.
    pub fn stop(&self) {
        self.0.send(Event::StopRequested);
    }
}

/// Where a VM is in its life.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum VmState {
    /// Built; [`Vm::run`] has not started.
    Created,
    /// [`Vm::run`] has started. A VM runs once, so it never leaves this state.
    Exited,
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
    vcpu_count: u8,
    state: VmState,
    fresh_vm: bool,
    host_vm: Option<Arc<H>>,
    ram: GuestRam,
}

impl<H: HostVm> std::fmt::Debug for Vm<H> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (vcpus, state) = (self.vcpu_count, self.state);
        f.debug_struct("Vm")
            .field("vcpus", &vcpus)
            .field("state", &state)
            .finish_non_exhaustive()
    }
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
impl Vm<boxlite_hypervisor::KvmVm> {
    /// Validates `config` and preflights the RAM layout and boot leaf against
    /// KVM before spawning the console worker and building the VM.
    /// `devices::add_all` adds the legacy devices and one virtio-blk device
    /// per disk, taking each disk's virtio-mmio slot and naming it on the
    /// command line; `config.cmdline` must leave room for those arguments,
    /// about 35 bytes each, under `config::MAX_CMDLINE_BYTES`. The guest's
    /// COM1 output goes to `console` through a queue, so a slow sink never
    /// stalls the guest.
    pub fn new(config: VmConfig, console: Box<dyn std::io::Write + Send>) -> Result<Self> {
        use crate::{boot, cpu_features::preflight_x86, devices::console::DEFAULT_QUEUE_BYTES};

        config.validate()?;
        let prepared = boxlite_hypervisor::KvmVm::prepare()?;
        let leaf = preflight_x86(
            config.memory_mib,
            prepared.supported_cpuid(),
            boot::BOOT_LEAF,
        )?;
        let (writer, worker) =
            ConsoleWorker::spawn(console, DEFAULT_QUEUE_BYTES).map_err(Error::SpawnConsole)?;
        let mut vm = Self::build(
            config,
            move || boxlite_hypervisor::KvmVm::from_prepared(prepared),
            true,
            VirtioWorkers::new,
            move |ram, config| boot::prepare(ram, config, leaf).map(|setup| setup.boot_regs),
            |chipset, ctx, config| crate::devices::add_all(chipset, ctx, config, writer),
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
        Self::with_devices(config, host_vm, boot, |chipset, ctx, _| {
            devices(chipset, ctx)
        })
    }

    #[cfg(test)]
    pub(crate) fn with_devices(
        config: VmConfig,
        host_vm: impl FnOnce() -> boxlite_hypervisor::Result<H>,
        boot: impl FnOnce(&GuestRam, &VmConfig) -> Result<BootRegisters>,
        devices: impl FnOnce(&mut ChipsetBuilder, DeviceContext<'_>, &mut VmConfig) -> Result<()>,
    ) -> Result<Self>
    where
        H: 'static,
    {
        Self::build(config, host_vm, false, VirtioWorkers::new, boot, devices)
    }

    /// Validates `config`, allocates the RAM layout, creates the host VM with
    /// `host_vm`, builds the chipset from the devices `devices` adds,
    /// registers every RAM range and writes the boot data with `boot`.
    /// `devices` also gets the guest memory, the virtio workers and the
    /// mutable configuration. Invalid configuration fails before `host_vm`
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
        devices: impl FnOnce(&mut ChipsetBuilder, DeviceContext<'_>, &mut VmConfig) -> Result<()>,
    ) -> Result<Self>
    where
        H: 'static,
    {
        let mut config = config;
        config.validate()?;
        let events = EventLoop::new().map_err(Error::EventLoop)?;
        let sender = events.sender();
        // Allocating first keeps the drop order safe on every early return:
        // locals drop in reverse order, so the host VM goes before the RAM.
        let mut ram = GuestRam::new(&ram_ranges(config.memory_mib))?;
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
            &mut config,
        )?;
        let chipset = chipset.build()?;
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

        let mut vm = Self {
            chipset: Some(chipset),
            workers: Some(workers),
            console: Mutex::new(None),
            control: controls.finish(),
            events: Mutex::new(events),
            sender,
            boot_regs: BootRegisters::default(),
            vcpu_count: config.vcpu_count,
            state: VmState::Created,
            fresh_vm,
            host_vm: Some(host_vm),
            ram,
        };
        vm.boot_regs = boot(&vm.ram, &config)?;
        Ok(vm)
    }

    /// A handle that stops this VM from another thread, even before
    /// [`run`](Self::run) starts.
    pub fn stop_handle(&self) -> StopHandle {
        StopHandle(self.sender.clone())
    }

    /// Controls the VM from another thread, addressing disks by their configured IDs.
    pub fn control(&self) -> VmControl {
        self.control.clone()
    }
}

#[cfg(target_arch = "x86_64")]
impl<H: boxlite_hypervisor::X86Vm> Vm<H> {
    /// Runs every vCPU on its own thread until the first event ends the VM,
    /// stops and joins them all, shuts the virtio workers down, and returns
    /// how the VM ended. Workers that do not shut down fail a run that
    /// otherwise ended cleanly. A VM runs once; a second call fails with
    /// [`Error::AlreadyRan`].
    pub fn run(&mut self) -> Result<VmExit> {
        use std::{sync::PoisonError, thread};

        use boxlite_hypervisor::VcpuHandle as _;

        use crate::vcpu::{StartGate, Workers};

        if self.state != VmState::Created {
            return Err(Error::AlreadyRan);
        }
        self.state = VmState::Exited;
        let gate = StartGate::default();
        let kicks = Mutex::new(Vec::new());
        let vcpus = Workers {
            host_vm: self.host_vm.as_deref().expect("live VM has a host VM"),
            vcpu_count: self.vcpu_count,
            boot_regs: &self.boot_regs,
            chipset: self.chipset.as_ref().expect("live VM has a chipset"),
            sender: &self.sender,
            kicks: &kicks,
            gate: &gate,
        };
        let events = self
            .events
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner);
        let event = thread::scope(|scope| {
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
            let event = events.wait(None);
            if event.is_err() {
                // Without an event the stop latch is still open; close it so
                // the vCPUs stop and the scope can join them.
                vcpus.sender.send(Event::StopRequested);
            }
            // Wake every vCPU still in the guest; a vCPU still being
            // configured sees the latch before its first entry.
            for kick in kicks.lock().unwrap_or_else(PoisonError::into_inner).iter() {
                if let Err(error) = kick.kick() {
                    tracing::warn!(%error, "failed to kick a vCPU");
                }
            }
            event
        });
        // No vCPU notifies a queue any more. Stop the virtio devices before the
        // console finishes, so a device's last output still reaches the sink.
        let workers = self.workers.as_ref().expect("live VM has virtio workers");
        let shutdown = workers.shutdown().map_err(Error::from);
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
        let ended = match event {
            Ok(Some(Event::StopRequested)) => Ok(VmExit::StopRequested),
            Ok(Some(Event::GuestShutdown)) => Ok(VmExit::GuestShutdown),
            Ok(Some(Event::GuestReset)) => Ok(VmExit::GuestReset),
            Ok(Some(Event::VcpuFailed(error) | Event::DeviceFailed(error))) => Err(error),
            Ok(None) => unreachable!("a wait without a timeout returns an event"),
            Err(error) => Err(Error::EventLoop(error)),
        };
        // The error that ended the VM stays the one the caller sees.
        match (ended, shutdown) {
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

impl<H: HostVm> Drop for Vm<H> {
    fn drop(&mut self) {
        // A device event that outlived the shutdown may still touch guest
        // RAM, so the registrations stay and `GuestRam` leaks the backing.
        let workers = self.workers.as_ref().expect("live VM has virtio workers");
        if let Err(ShutdownError::Join(error)) = workers.shutdown() {
            tracing::warn!(%error, "the virtio workers did not stop; leaking guest RAM");
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
        if self.fresh_vm && self.state == VmState::Created {
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
