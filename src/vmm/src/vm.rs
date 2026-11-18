// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The VM facade: configuration, host VM creation, RAM registration, boot
//! loading, and running the vCPUs until the VM ends.

use std::sync::{Arc, Mutex};

use boxlite_hypervisor::Vm as HostVm;

use crate::{
    chipset::{Chipset, ChipsetBuilder},
    config::VmConfig,
    control::{Requests, VcpuControl},
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
    // Field order is load-bearing: devices go first, then the host VM, which
    // releases its guest mappings, then the RAM that backs them. `Drop`
    // unmaps the RAM anyway, since a device's interrupt line holds the host
    // VM longer.
    chipset: Chipset,
    /// Runs every virtio device's events on one thread; `run` and `Drop` shut
    /// them down before the RAM is released.
    workers: VirtioWorkers,
    /// The worker writing the guest console to the caller's sink; `run`
    /// finishes it once every vCPU has stopped. The lock only makes `Vm`
    /// `Sync`; `run` reaches it through `&mut self`.
    console: Mutex<Option<ConsoleWorker>>,
    events: Mutex<EventLoop>,
    sender: EventSender,
    /// vCPU control requests, which `run` serves.
    requests: Requests,
    boot_regs: BootRegisters,
    /// vCPUs online at boot.
    vcpu_count: u8,
    /// vCPUs the guest's topology lists; the rest of `vcpu_count` start parked.
    max_vcpus: u8,
    state: VmState,
    host_vm: Arc<H>,
    ram: GuestRam,
}

impl<H: HostVm> std::fmt::Debug for Vm<H> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (vcpus, max_vcpus, state) = (self.vcpu_count, self.max_vcpus, self.state);
        f.debug_struct("Vm")
            .field("vcpus", &vcpus)
            .field("max_vcpus", &max_vcpus)
            .field("state", &state)
            .finish_non_exhaustive()
    }
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
impl Vm<boxlite_hypervisor::KvmVm> {
    /// Validates `config`, spawns the console worker, and builds the KVM VM:
    /// `devices::add_all` adds the legacy devices and one virtio-blk device
    /// per disk, taking each disk's virtio-mmio slot and naming it on the
    /// command line; `config.cmdline` must leave room for those arguments,
    /// about 35 bytes each, under `config::MAX_CMDLINE_BYTES`. The guest's
    /// COM1 output goes to `console` through a queue, so a slow sink never
    /// stalls the guest.
    pub fn new(config: VmConfig, console: Box<dyn std::io::Write + Send>) -> Result<Self> {
        use crate::devices::console::DEFAULT_QUEUE_BYTES;

        config.validate()?;
        let (writer, worker) =
            ConsoleWorker::spawn(console, DEFAULT_QUEUE_BYTES).map_err(Error::SpawnConsole)?;
        let mut vm = Self::with_devices(
            config,
            boxlite_hypervisor::KvmVm::new,
            |ram, config| crate::boot::prepare(ram, config).map(|setup| setup.boot_regs),
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

    /// Validates `config`, allocates the RAM layout, creates the host VM with
    /// `host_vm`, builds the chipset from the devices `devices` adds,
    /// registers every RAM range and writes the boot data with `boot`.
    /// `devices` also gets the guest memory, the virtio workers and the
    /// mutable configuration. Invalid configuration fails before `host_vm`
    /// runs, and a chipset conflict before any RAM is registered; tests pass
    /// a mock backend and devices.
    #[cfg_attr(
        not(any(test, all(target_os = "linux", target_arch = "x86_64"))),
        expect(
            dead_code,
            reason = "Only the Linux x86_64 Vm::new composes devices yet."
        )
    )]
    pub(crate) fn with_devices(
        config: VmConfig,
        host_vm: impl FnOnce() -> boxlite_hypervisor::Result<H>,
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
        let workers = VirtioWorkers::new(sender.clone()).map_err(Error::VirtioWorker)?;
        let mut chipset = ChipsetBuilder::new(host_vm.clone(), sender.clone());
        devices(
            &mut chipset,
            DeviceContext {
                memory: ram.memory(),
                workers: &workers,
            },
            &mut config,
        )?;
        let chipset = chipset.build()?;
        ram.map(&*host_vm)?;
        // From here on `Drop` unmaps the RAM if a later step fails.
        let mut vm = Self {
            chipset,
            workers,
            console: Mutex::new(None),
            events: Mutex::new(events),
            sender,
            requests: Requests::new(),
            boot_regs: BootRegisters::default(),
            vcpu_count: config.vcpu_count,
            max_vcpus: config.max_vcpus,
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

    /// A handle that changes how many vCPUs may run while
    /// [`run`](Self::run) runs.
    pub fn vcpu_control(&self) -> VcpuControl {
        VcpuControl::new(&self.requests, self.sender.clone(), self.max_vcpus)
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

        use crate::vcpu::{Slots, StartGate, Workers};

        if self.state != VmState::Created {
            return Err(Error::AlreadyRan);
        }
        self.state = VmState::Exited;
        let gate = StartGate::default();
        let slots = Slots::new(self.max_vcpus);
        let vcpus = Workers {
            host_vm: &*self.host_vm,
            max_vcpus: self.max_vcpus,
            online_count: self.vcpu_count,
            boot_regs: &self.boot_regs,
            chipset: &self.chipset,
            sender: &self.sender,
            slots: &slots,
            gate: &gate,
        };
        let requests = &self.requests;
        let events = self
            .events
            .get_mut()
            .unwrap_or_else(PoisonError::into_inner);
        let event = thread::scope(|scope| {
            // Every possible vCPU is created and configured at boot; the ones
            // past `online_count` park and their threads exit.
            for id in 0..vcpus.max_vcpus {
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
            let event = loop {
                match events.wait_once() {
                    Ok(Some(event)) => break Ok(Some(event)),
                    Ok(None) => {
                        while let Some(request) = requests.try_next() {
                            let answer = set_online(&vcpus, scope, request.count);
                            // A caller that gave up has dropped its receiver.
                            let _ = request.reply.send(answer);
                        }
                    }
                    Err(error) => break Err(error),
                }
            };
            if event.is_err() {
                // Without an event the stop latch is still open; close it so
                // the vCPUs stop and the scope can join them.
                vcpus.sender.send(Event::StopRequested);
            }
            requests.close();
            // Wake every vCPU still in the guest; a vCPU still being
            // configured sees the latch before its first entry.
            slots.kick_running();
            event
        });
        // No vCPU notifies a queue any more. Stop the virtio devices before the
        // console finishes, so a device's last output still reaches the sink.
        let shutdown = self.workers.shutdown().map_err(Error::from);
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

/// Grants parked vCPUs, lowest IDs first, or revokes running ones, highest
/// first, until `count` run; returns how many run.
#[cfg(target_arch = "x86_64")]
fn set_online<'scope, H: boxlite_hypervisor::X86Vm>(
    vcpus: &'scope crate::vcpu::Workers<'scope, H>,
    scope: &'scope std::thread::Scope<'scope, '_>,
    count: u8,
) -> Result<u8> {
    vcpus.slots.wait_settled(vcpus.sender);
    let running = vcpus.slots.running();
    if usize::from(count) > running.len() {
        let wanted = usize::from(count) - running.len();
        for id in vcpus.slots.parked().into_iter().take(wanted) {
            let parked = vcpus.slots.take_for_grant(id)?;
            std::thread::Builder::new()
                .name(format!("vcpu{id}"))
                .spawn_scoped(scope, move || vcpus.resume(parked, id))
                .map_err(|source| Error::SpawnVcpu {
                    vcpu: id.into(),
                    source,
                })?;
            vcpus.slots.wait_started(id);
        }
    } else {
        for &id in running
            .iter()
            .rev()
            .take(running.len() - usize::from(count))
        {
            vcpus.slots.revoke(id)?;
        }
    }
    Ok(u8::try_from(vcpus.slots.running().len()).expect("at most MAX_VCPUS run"))
}

impl<H: HostVm> Drop for Vm<H> {
    fn drop(&mut self) {
        // A device event that outlived the shutdown may still touch guest
        // RAM, so the registrations stay and `GuestRam` leaks the backing.
        if let Err(ShutdownError::Join(error)) = self.workers.shutdown() {
            tracing::warn!(%error, "the virtio workers did not stop; leaking guest RAM");
            return;
        }
        // Quiesce failure after joining cannot leave a live callback. A VM
        // that never ran also holds registrations; remove them so the backing
        // can be released. `GuestRam` leaks it on unmap failure.
        let _ = self.ram.unmap(&*self.host_vm);
    }
}

// The file lives under `tests/` so the suite stays out of the crate's counted
// source; it is still a unit-test module with access to crate-private items.
#[cfg(test)]
#[path = "../tests/vm/mod.rs"]
mod tests;
