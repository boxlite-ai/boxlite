// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The VM facade: configuration, host VM creation, RAM registration, boot
//! loading, and running the vCPUs until the VM ends.

use std::sync::{Arc, Mutex};

use boxlite_hypervisor::Vm as HostVm;

use crate::{
    chipset::{Chipset, ChipsetBuilder},
    config::VmConfig,
    devices::console::ConsoleWorker,
    error::{Error, Result},
    events::{Event, EventLoop, EventSender},
    memory::{GuestRam, ram_ranges},
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
    // Field order is load-bearing: devices go first, then the host VM, which
    // releases its guest mappings, then the RAM that backs them. `Drop`
    // unmaps the RAM anyway, since a device's interrupt line holds the host
    // VM longer.
    chipset: Chipset,
    /// The worker writing the guest console to the caller's sink; `run`
    /// finishes it once every vCPU has stopped. The lock only makes `Vm`
    /// `Sync`; `run` reaches it through `&mut self`.
    console: Mutex<Option<ConsoleWorker>>,
    events: Mutex<EventLoop>,
    sender: EventSender,
    boot_regs: BootRegisters,
    vcpu_count: u8,
    state: VmState,
    host_vm: Arc<H>,
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
    /// Validates `config`, creates the KVM VM with the legacy devices,
    /// registers its RAM and loads the kernel and boot data. The guest's COM1
    /// output goes to `console` through a queue, so a slow sink never stalls
    /// the guest.
    pub fn new(config: VmConfig, console: Box<dyn std::io::Write + Send>) -> Result<Self> {
        use crate::devices::{
            cmos::host_clock, console::DEFAULT_QUEUE_BYTES, x86_64::add_legacy_devices,
        };

        let (writer, worker) =
            ConsoleWorker::spawn(console, DEFAULT_QUEUE_BYTES).map_err(Error::SpawnConsole)?;
        let mut vm = Self::with_backend(
            config,
            boxlite_hypervisor::KvmVm::new,
            |ram, config| crate::boot::prepare(ram, config).map(|setup| setup.boot_regs),
            |chipset| add_legacy_devices(chipset, writer, Box::new(host_clock)),
        )?;
        vm.console = Mutex::new(Some(worker));
        Ok(vm)
    }
}

impl<H: HostVm> Vm<H> {
    /// Validates `config`, allocates the RAM layout, creates the host VM with
    /// `host_vm`, builds the chipset from the devices `devices` adds,
    /// registers every RAM range and writes the boot data with `boot`.
    /// Invalid configuration fails before `host_vm` runs, and a chipset
    /// conflict before any RAM is registered; tests pass a mock backend and
    /// devices.
    pub(crate) fn with_backend(
        config: VmConfig,
        host_vm: impl FnOnce() -> boxlite_hypervisor::Result<H>,
        boot: impl FnOnce(&GuestRam, &VmConfig) -> Result<BootRegisters>,
        devices: impl FnOnce(&mut ChipsetBuilder) -> Result<()>,
    ) -> Result<Self>
    where
        H: 'static,
    {
        config.validate()?;
        let events = EventLoop::new().map_err(Error::EventLoop)?;
        let sender = events.sender();
        // Allocating first keeps the drop order safe on every early return:
        // locals drop in reverse order, so the host VM goes before the RAM.
        let mut ram = GuestRam::new(&ram_ranges(config.memory_mib))?;
        let host_vm = Arc::new(host_vm()?);
        let mut chipset = ChipsetBuilder::new(host_vm.clone(), sender.clone());
        devices(&mut chipset)?;
        let chipset = chipset.build()?;
        ram.map(&*host_vm)?;
        // From here on `Drop` unmaps the RAM if a later step fails.
        let mut vm = Self {
            chipset,
            console: Mutex::new(None),
            events: Mutex::new(events),
            sender,
            boot_regs: BootRegisters::default(),
            vcpu_count: config.vcpu_count,
            state: VmState::Created,
            host_vm,
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

    /// The chipset, for tests that read its counters after a run.
    #[cfg(test)]
    pub(crate) fn chipset(&self) -> &Chipset {
        &self.chipset
    }
}

#[cfg(target_arch = "x86_64")]
impl<H: boxlite_hypervisor::X86Vm> Vm<H> {
    /// Runs every vCPU on its own thread until the first event ends the VM,
    /// stops and joins them all, and returns how the VM ended. A VM runs
    /// once; a second call fails with [`Error::AlreadyRan`].
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
        let workers = Workers {
            host_vm: &*self.host_vm,
            vcpu_count: self.vcpu_count,
            boot_regs: &self.boot_regs,
            chipset: &self.chipset,
            sender: &self.sender,
            kicks: &kicks,
            gate: &gate,
        };
        let events = self
            .events
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner);
        let event = thread::scope(|scope| {
            for id in 0..workers.vcpu_count {
                let workers = &workers;
                let spawned = thread::Builder::new()
                    .name(format!("vcpu{id}"))
                    .spawn_scoped(scope, move || workers.run(id));
                if let Err(source) = spawned {
                    let vcpu = id.into();
                    workers
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
                workers.sender.send(Event::StopRequested);
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
        match event.map_err(Error::EventLoop)? {
            Some(Event::StopRequested) => Ok(VmExit::StopRequested),
            Some(Event::GuestShutdown) => Ok(VmExit::GuestShutdown),
            Some(Event::GuestReset) => Ok(VmExit::GuestReset),
            Some(Event::VcpuFailed(error) | Event::DeviceFailed(error)) => Err(error),
            None => unreachable!("a wait without a timeout returns an event"),
        }
    }
}

impl<H: HostVm> Drop for Vm<H> {
    fn drop(&mut self) {
        // A VM that never ran still holds its registrations. Remove them so
        // the backing can be released; `GuestRam` leaks it on failure.
        let _ = self.ram.unmap(&*self.host_vm);
    }
}

// The file lives under `tests/` so the suite stays out of the crate's counted
// source; it is still a unit-test module with access to crate-private items.
#[cfg(test)]
#[path = "../tests/vm/mod.rs"]
mod tests;
