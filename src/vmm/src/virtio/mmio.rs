// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The virtio-mmio transport.
//!
//! The transport owns the register file, queue configuration, status and
//! interrupt of one device. It is a [`BusDevice`] on a 4 KiB MMIO window.
//! Control registers take aligned 4-byte accesses; the configuration space
//! forwards 1-, 2- and 4-byte accesses and splits an 8-byte access into two
//! 4-byte device calls.
//!
//! During negotiation the transport holds a dense [`QueueConfig`] shadow, one
//! per `DeviceSpec::queue_max` slot. At DRIVER_OK it builds the
//! `virtio_queue::Queue` values, prepares them into the [`VirtQueues`] facade,
//! and moves them into the device's [`ActivationContext`]. After DRIVER_OK the
//! device owns the queues; the transport rejects and logs every
//! queue-configuration write, as Firecracker does. QueueNotify, InterruptACK
//! and Status stay live, and Status=0 is the only queue-reconfiguration path.
//!
//! The transport drives the device's slot in the virtio workers through
//! [`WorkerControl`]: it prepares a generation before activation, starts it
//! after, kicks it on QueueNotify and stops it before Status=0 resets the
//! device. It never calls the workers while holding the device lock. A device
//! failure updates the shared status and raises the configuration interrupt,
//! or sends [`Event::DeviceFailed`] to the run thread without stopping the
//! worker slot synchronously.

use std::sync::{Arc, Mutex};

use virtio_queue::{Queue, QueueT};
use vm_memory::GuestAddress;

use super::{
    ActivationContext, DeviceContext, DeviceError, DeviceSpec, MAX_CONFIG_LEN, MAX_QUEUES,
    NEEDS_RESET, VirtioDevice, VirtioInterrupt, WorkerContext, WorkerControl,
    interrupt::MmioInterrupt,
    queue::{VIRTIO_F_EVENT_IDX, VIRTIO_F_INDIRECT_DESC, VirtQueues},
};
use crate::{
    bus::BusDevice,
    chipset::ChipsetBuilder,
    error::{Error, Result},
    events::{Event, EventSender},
    memory::GuestMemoryMmap,
};

/// The MMIO window length a transport claims.
pub(crate) const MMIO_WINDOW_LEN: u64 = 0x1000;
/// Where the virtio-mmio windows start; slot `i` is `i` windows later.
const WINDOW_START: u64 = 0xd000_0000;
/// The interrupt lines the slots use, in order: the legacy range above COM1
/// and below the MSI space, as Firecracker and libkrun allocate it.
const FIRST_GSI: u32 = 5;
const LAST_GSI: u32 = 23;

/// One virtio-mmio device's window and interrupt line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Slot {
    /// The window base.
    pub(crate) base: u64,
    /// The interrupt line.
    pub(crate) gsi: u32,
}

impl Slot {
    /// The `virtio_mmio.device=` argument that makes the kernel probe this
    /// slot.
    pub(crate) fn cmdline_arg(&self) -> String {
        format!("virtio_mmio.device=4K@{:#x}:{}", self.base, self.gsi)
    }
}

/// Hands out the slots of one VM in order, so every virtio-mmio device gets
/// a distinct window and line, and the command line names the same values.
#[derive(Debug, Default)]
pub(crate) struct Slots {
    taken: u32,
}

impl Slots {
    /// How many slots a VM has.
    pub(crate) const CAPACITY: u32 = LAST_GSI - FIRST_GSI + 1;

    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// The next free slot.
    pub(crate) fn take(&mut self) -> Result<Slot> {
        if self.taken >= Self::CAPACITY {
            return Err(Error::VirtioSlotsExhausted);
        }
        let index = self.taken;
        self.taken += 1;
        Ok(Slot {
            base: WINDOW_START + u64::from(index) * MMIO_WINDOW_LEN,
            gsi: FIRST_GSI + index,
        })
    }
}

/// Puts each slot's argument at the front of `cmdline`, which must leave room
/// for them under `MAX_CMDLINE_BYTES`: the kernel probes a virtio-mmio device
/// only when the command line names it, and copies at most that many bytes.
/// The front is always before a `--`, after which the kernel hands everything
/// to the init program, so the caller's text is never parsed.
pub(crate) fn announce(cmdline: &mut String, slots: &[Slot]) -> Result<()> {
    if slots.is_empty() {
        return Ok(());
    }
    let mut announced = slots
        .iter()
        .map(Slot::cmdline_arg)
        .collect::<Vec<_>>()
        .join(" ");
    if !cmdline.is_empty() {
        announced.push(' ');
        announced.push_str(cmdline);
    }
    if announced.len() >= crate::config::MAX_CMDLINE_BYTES {
        return Err(Error::InvalidCommandLine(
            "leaves no room for the virtio device arguments",
        ));
    }
    *cmdline = announced;
    Ok(())
}

/// Adds `device` behind a virtio-mmio transport in `slot` under the chipset
/// name `name`, run by the VM's workers.
#[cfg_attr(
    not(any(test, all(target_os = "linux", target_arch = "x86_64"))),
    expect(
        dead_code,
        reason = "Only the Linux x86_64 Vm::new attaches a virtio device yet."
    )
)]
pub(crate) fn add_device(
    chipset: &mut ChipsetBuilder,
    ctx: &DeviceContext<'_>,
    name: &'static str,
    slot: Slot,
    device: Arc<Mutex<dyn VirtioDevice>>,
) -> Result<()> {
    chipset.add(name, |resources| {
        resources.mmio(slot.base, MMIO_WINDOW_LEN);
        let interrupt = Arc::new(MmioInterrupt::new(resources.line(slot.gsi)));
        let worker = ctx.workers.add(
            Arc::clone(&device),
            Arc::clone(&interrupt) as Arc<dyn VirtioInterrupt>,
        );
        MmioTransport::new(
            device,
            interrupt,
            MmioResources {
                memory: Arc::clone(ctx.memory),
                sender: resources.event_sender(),
                worker,
            },
        )
    })
}

/// The driver acknowledged the device.
const ACKNOWLEDGE: u8 = 0x1;
/// The driver knows the device.
const DRIVER: u8 = 0x2;
/// The driver is ready.
const DRIVER_OK: u8 = 0x4;
/// The driver accepted the device features.
const FEATURES_OK: u8 = 0x8;
/// The driver failed the device.
const FAILED: u8 = 0x80;
/// The status bits a driver may set.
const DRIVER_STATUS_BITS: u8 = ACKNOWLEDGE | DRIVER | DRIVER_OK | FEATURES_OK | FAILED;

/// `VIRTIO_F_VERSION_1`: the device uses the modern virtio layout.
pub(crate) const VIRTIO_F_VERSION_1: u64 = 1 << 32;
/// `VIRTIO_F_RING_PACKED`: packed virtqueues are not implemented.
const VIRTIO_F_RING_PACKED: u64 = 1 << 34;
/// `VIRTIO_F_NOTIFICATION_DATA`: the transport does not decode packed
/// notifications.
const VIRTIO_F_NOTIFICATION_DATA: u64 = 1 << 38;
/// `VIRTIO_F_NOTIF_CONFIG_DATA`: the transport does not implement it.
const VIRTIO_F_NOTIF_CONFIG_DATA: u64 = 1 << 39;
/// `VIRTIO_F_RING_RESET`: per-queue reset is not implemented.
const VIRTIO_F_RING_RESET: u64 = 1 << 40;
/// `VIRTIO_F_ADMIN_VQ`: there is no admin queue.
const VIRTIO_F_ADMIN_VQ: u64 = 1 << 41;

/// Transport features a device must not offer through this transport.
const UNSUPPORTED_TRANSPORT_FEATURES: u64 = VIRTIO_F_RING_PACKED
    | VIRTIO_F_NOTIFICATION_DATA
    | VIRTIO_F_NOTIF_CONFIG_DATA
    | VIRTIO_F_RING_RESET
    | VIRTIO_F_ADMIN_VQ;

/// The configuration space begins here.
const CONFIG_OFFSET: u64 = 0x100;
/// The virtio-mmio magic value, little endian.
const MAGIC_VALUE: u32 = 0x7472_6976;
/// The modern virtio-mmio version.
const VERSION: u32 = 2;
/// The vendor ID reported to the guest.
const VENDOR_ID: u32 = 0;

/// A device method result.
type DeviceResult<T> = std::result::Result<T, DeviceError>;

/// The resources a transport shares with its device and the workers.
pub(crate) struct MmioResources {
    /// The guest memory the queues address.
    pub(crate) memory: Arc<GuestMemoryMmap>,
    /// The run thread's event sender.
    pub(crate) sender: EventSender,
    /// The device's slot in the virtio workers.
    pub(crate) worker: Arc<dyn WorkerControl>,
}

/// The transport's queue configuration before DRIVER_OK.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct QueueConfig {
    /// The guest-selected queue size, or the maximum initially.
    size: u32,
    /// The descriptor table address.
    desc: u64,
    /// The available ring address.
    avail: u64,
    /// The used ring address.
    used: u64,
    /// The last QueueReady value written.
    ready: u32,
}

/// The virtio-mmio transport for one device.
pub(crate) struct MmioTransport {
    device: Arc<Mutex<dyn VirtioDevice>>,
    interrupt: Arc<super::interrupt::MmioInterrupt>,
    memory: Arc<GuestMemoryMmap>,
    sender: EventSender,
    worker: Arc<dyn WorkerControl>,
    spec: DeviceSpec,
    device_features_sel: u32,
    driver_features_sel: u32,
    driver_features: u64,
    features_ok: bool,
    active: bool,
    queue_sel: u32,
    queues: Vec<QueueConfig>,
}

impl MmioTransport {
    /// Builds a transport for `device` on `interrupt`.
    ///
    /// Fails when the device specification cannot fit the MMIO transport.
    pub(crate) fn new(
        device: Arc<Mutex<dyn VirtioDevice>>,
        interrupt: Arc<super::interrupt::MmioInterrupt>,
        resources: MmioResources,
    ) -> Result<Self> {
        let spec = *device
            .lock()
            .expect("a virtio device lock is poisoned")
            .spec();
        if spec.device_id == 0 {
            return Err(Error::VirtioDevice {
                device: spec.name,
                reason: "device ID is zero",
            });
        }
        if spec.config_len > MAX_CONFIG_LEN {
            return Err(Error::VirtioDevice {
                device: spec.name,
                reason: "configuration space is too large",
            });
        }
        if spec.queue_max.len() > MAX_QUEUES {
            return Err(Error::VirtioDevice {
                device: spec.name,
                reason: "too many queues",
            });
        }
        if spec.queue_max.iter().any(|&max| Queue::new(max).is_err()) {
            return Err(Error::VirtioDevice {
                device: spec.name,
                reason: "queue maximum size is invalid",
            });
        }
        let queues = fresh_queues(&spec);
        Ok(Self {
            device,
            interrupt,
            memory: resources.memory,
            sender: resources.sender,
            worker: resources.worker,
            spec,
            device_features_sel: 0,
            driver_features_sel: 0,
            driver_features: 0,
            features_ok: false,
            active: false,
            queue_sel: 0,
            queues,
        })
    }

    /// The offered features: the device's own, plus the transport-owned
    /// VERSION_1, minus transport features this transport does not implement.
    fn offered_features(&self) -> u64 {
        (self.spec.features | VIRTIO_F_VERSION_1) & !UNSUPPORTED_TRANSPORT_FEATURES
    }

    /// The current device status.
    fn status(&self) -> u8 {
        self.interrupt.device_status()
    }

    /// Whether a queue configuration write is legal.
    fn queue_writable(&self) -> bool {
        let status = self.status();
        status & FEATURES_OK != 0 && status & (DRIVER_OK | FAILED | NEEDS_RESET) == 0
    }

    /// The selected queue configuration.
    fn queue(&self) -> Option<&QueueConfig> {
        self.queues.get(self.queue_sel as usize)
    }

    /// The selected queue configuration, mutably.
    fn queue_mut(&mut self) -> Option<&mut QueueConfig> {
        self.queues.get_mut(self.queue_sel as usize)
    }

    /// Reads one 4-byte control register.
    fn read_control(&self, offset: u64) -> u32 {
        match offset {
            0x000 => MAGIC_VALUE,
            0x004 => VERSION,
            0x008 => self.spec.device_id,
            0x00c => VENDOR_ID,
            0x010 => {
                let sel = self.device_features_sel;
                if sel < 2 {
                    (self.offered_features() >> (sel * 32)) as u32
                } else {
                    0
                }
            }
            0x034 => self.queue().map_or(0, |_| {
                u32::from(self.spec.queue_max[self.queue_sel as usize])
            }),
            0x044 => self.queue().map_or(0, |queue| queue.ready),
            0x060 => u32::from(self.interrupt.interrupt_status()),
            0x070 => u32::from(self.status()),
            0x0b0 | 0x0b4 | 0x0b8 | 0x0bc => u32::MAX,
            0x0fc => u32::from(self.interrupt.config_generation()),
            _ => 0,
        }
    }

    /// Writes one 4-byte control register.
    fn write_control(&mut self, offset: u64, value: u32) {
        match offset {
            0x014 => self.device_features_sel = value,
            0x020 => self.write_driver_features(value),
            0x024 => self.driver_features_sel = value,
            0x050 => self.notify(value),
            0x064 => self.interrupt.ack_interrupt(value as u8),
            0x070 => self.write_status(value),
            0x0ac => {
                tracing::debug!(offset, "ignoring the MMIO SHM selector");
            }
            0x030 => {
                if self.queue_writable() {
                    self.queue_sel = value;
                } else {
                    tracing::debug!(offset, "ignoring a queue register write");
                }
            }
            0x038 => {
                if self.queue_writable() {
                    if let Some(queue) = self.queue_mut() {
                        queue.size = value;
                    }
                } else {
                    tracing::debug!(offset, "ignoring a queue register write");
                }
            }
            0x044 => {
                if !self.queue_writable() {
                    tracing::debug!(offset, "ignoring a queue register write");
                    return;
                }
                if value > 1 {
                    tracing::debug!(value, "ignoring a non-boolean QueueReady write");
                    return;
                }
                if let Some(queue) = self.queue_mut() {
                    queue.ready = value;
                }
            }
            0x080..=0x0a4 => self.write_queue_address(offset, value),
            _ => tracing::debug!(offset, "ignoring an unknown MMIO register write"),
        }
    }

    /// Latches one half of the driver's accepted features.
    fn write_driver_features(&mut self, value: u32) {
        if self.features_ok || self.status() & (FEATURES_OK | FAILED | NEEDS_RESET) != 0 {
            tracing::debug!("ignoring a DriverFeatures write after FEATURES_OK");
            return;
        }
        match self.driver_features_sel {
            0 => {
                self.driver_features =
                    (self.driver_features & !u64::from(u32::MAX)) | u64::from(value);
            }
            1 => {
                self.driver_features =
                    (self.driver_features & u64::from(u32::MAX)) | (u64::from(value) << 32);
            }
            _ => tracing::debug!(
                selector = self.driver_features_sel,
                "ignoring an invalid DriverFeaturesSel"
            ),
        }
    }

    /// Latches one half of a queue address.
    fn write_queue_address(&mut self, offset: u64, value: u32) {
        if !self.queue_writable() {
            tracing::debug!(offset, "ignoring a queue register write");
            return;
        }
        let Some(queue) = self.queue_mut() else {
            return;
        };
        match offset {
            0x080 => queue.desc = (queue.desc & !u64::from(u32::MAX)) | u64::from(value),
            0x084 => {
                queue.desc = (queue.desc & u64::from(u32::MAX)) | (u64::from(value) << 32);
            }
            0x090 => queue.avail = (queue.avail & !u64::from(u32::MAX)) | u64::from(value),
            0x094 => {
                queue.avail = (queue.avail & u64::from(u32::MAX)) | (u64::from(value) << 32);
            }
            0x0a0 => queue.used = (queue.used & !u64::from(u32::MAX)) | u64::from(value),
            0x0a4 => {
                queue.used = (queue.used & u64::from(u32::MAX)) | (u64::from(value) << 32);
            }
            _ => tracing::debug!(offset, "ignoring an unknown queue address write"),
        }
    }

    /// Kicks the device's worker slot for a queue notification.
    fn notify(&mut self, value: u32) {
        if !self.active || self.status() & (FAILED | NEEDS_RESET) != 0 {
            tracing::debug!(value, "ignoring a queue notification before activation");
            return;
        }
        let index = (value & 0xffff) as u16;
        if usize::from(index) < self.queues.len() {
            self.worker.kick(index);
        } else {
            tracing::debug!(index, "ignoring an invalid queue notification");
        }
    }

    /// Handles a Status register write.
    fn write_status(&mut self, requested: u32) {
        if requested == 0 {
            self.reset();
            return;
        }
        // Reserved high bits must not turn a nonzero write into a reset.
        let requested = requested as u8;
        let current = self.status();
        if current & (FAILED | NEEDS_RESET) != 0 {
            tracing::debug!(
                current,
                requested,
                "ignoring a status write after FAILED or NEEDS_RESET"
            );
            return;
        }
        let bits = requested & DRIVER_STATUS_BITS;
        if bits == 0 {
            tracing::debug!(requested, "ignoring unknown status bits");
            return;
        }
        let new = current | bits;

        if bits & FAILED != 0 {
            self.interrupt.update_device_status(bits, 0);
            if self.active {
                match self.worker.stop() {
                    Ok(()) => self.active = false,
                    Err(error) => self.report_worker_failure(error),
                }
            }
            return;
        }

        if bits & FEATURES_OK != 0
            && current & FEATURES_OK == 0
            && (new & (ACKNOWLEDGE | DRIVER) != ACKNOWLEDGE | DRIVER || !self.negotiate_features())
        {
            self.interrupt
                .set_device_status(new & !(FEATURES_OK | DRIVER_OK));
            return;
        }

        if bits & DRIVER_OK != 0 && current & DRIVER_OK == 0 && !self.active {
            if new & (ACKNOWLEDGE | DRIVER | FEATURES_OK) != ACKNOWLEDGE | DRIVER | FEATURES_OK
                || !self.features_ok
            {
                self.interrupt.set_device_status(new & !DRIVER_OK);
                self.need_reset("driver status");
                return;
            }
            let worker = match self.worker.prepare() {
                Ok(worker) => worker,
                Err(error) => {
                    self.interrupt
                        .set_device_status((new & !DRIVER_OK) | NEEDS_RESET);
                    self.interrupt.raise_config();
                    self.report_worker_failure(error);
                    return;
                }
            };
            match self.activate(worker) {
                Ok(()) => {
                    self.interrupt.set_device_status(new);
                    match self.worker.start() {
                        Ok(()) => self.active = true,
                        Err(error) => {
                            self.worker.cancel_prepare();
                            self.interrupt
                                .set_device_status(self.status() | NEEDS_RESET);
                            self.interrupt.raise_config();
                            self.report_worker_failure(error);
                        }
                    }
                }
                Err(error) => {
                    self.worker.cancel_prepare();
                    let rollback = self
                        .device
                        .lock()
                        .expect("a virtio device lock is poisoned")
                        .reset();
                    if let Err(rollback_error) = rollback {
                        self.report_worker_failure(rollback_error);
                    }
                    self.features_ok = false;
                    self.interrupt
                        .set_device_status((new & !DRIVER_OK) | NEEDS_RESET);
                    self.interrupt.raise_config();
                    if matches!(error, DeviceError::Fatal(_)) {
                        self.report_worker_failure(error);
                    }
                }
            }
            return;
        }

        // A worker may set NEEDS_RESET while the driver writes, so OR the
        // driver's bits and leave the register alone when it did.
        self.interrupt
            .update_device_status(bits, FAILED | NEEDS_RESET);
    }

    /// Applies the accepted features to the device exactly once.
    fn negotiate_features(&mut self) -> bool {
        let offered = self.offered_features();
        if self.driver_features & VIRTIO_F_VERSION_1 == 0 {
            tracing::warn!("the driver did not accept VIRTIO_F_VERSION_1");
            return false;
        }
        if self.driver_features & !offered != 0 {
            tracing::warn!(
                unsupported = self.driver_features & !offered,
                "the driver accepted unsupported features"
            );
            return false;
        }
        let negotiated = self.driver_features & self.spec.features & !VIRTIO_F_VERSION_1;
        match self
            .device
            .lock()
            .expect("a virtio device lock is poisoned")
            .set_features(negotiated)
        {
            Ok(()) => {
                self.features_ok = true;
                true
            }
            Err(error) => {
                tracing::warn!(%error, "the device rejected the accepted features");
                false
            }
        }
    }

    /// Builds the dense queue vector and activates the device with the
    /// prepared `worker` generation.
    fn activate(&mut self, worker: WorkerContext) -> DeviceResult<()> {
        let mut queues = Vec::with_capacity(self.queues.len());
        for (slot, &max_size) in self.spec.queue_max.iter().enumerate() {
            let config = self.queues[slot];
            let mut queue =
                Queue::new(max_size).map_err(|_| DeviceError::Fatal("virtio queue maximum"))?;
            if config.ready != 0 {
                let size = u16::try_from(config.size)
                    .map_err(|_| DeviceError::NeedsReset("virtio queue size"))?;
                queue
                    .try_set_size(size)
                    .map_err(|_| DeviceError::NeedsReset("virtio queue size"))?;
                queue
                    .try_set_desc_table_address(GuestAddress(config.desc))
                    .map_err(|_| DeviceError::NeedsReset("virtio queue address"))?;
                queue
                    .try_set_avail_ring_address(GuestAddress(config.avail))
                    .map_err(|_| DeviceError::NeedsReset("virtio queue address"))?;
                queue
                    .try_set_used_ring_address(GuestAddress(config.used))
                    .map_err(|_| DeviceError::NeedsReset("virtio queue address"))?;
                queue.set_ready(true);
            }
            queues.push(queue);
        }
        let event_idx = self.driver_features & VIRTIO_F_EVENT_IDX != 0;
        let indirect = self.driver_features & VIRTIO_F_INDIRECT_DESC != 0;
        let queues = VirtQueues::prepare(
            queues,
            self.spec.queue_max,
            event_idx,
            indirect,
            Arc::clone(&self.memory),
        )
        .map_err(DeviceError::from)?;

        let interrupt: Arc<dyn VirtioInterrupt> = self.interrupt.clone();
        let ctx = ActivationContext {
            memory: Arc::clone(&self.memory),
            queues,
            interrupt,
            events: worker.events,
            waker: worker.waker,
            sender: self.sender.clone(),
        };
        self.device
            .lock()
            .expect("a virtio device lock is poisoned")
            .activate(ctx)
    }

    /// Resets the device and the transport on a Status=0 write.
    fn reset(&mut self) {
        if self.active {
            match self.worker.stop() {
                Ok(()) => self.active = false,
                Err(error) => {
                    self.report_worker_failure(error);
                    return;
                }
            }
        }
        let result = self
            .device
            .lock()
            .expect("a virtio device lock is poisoned")
            .reset();
        if let Err(error) = result {
            self.handle_device_error(error);
            return;
        }
        self.features_ok = false;
        self.driver_features = 0;
        self.device_features_sel = 0;
        self.driver_features_sel = 0;
        self.queue_sel = 0;
        self.queues = fresh_queues(&self.spec);
        self.interrupt.reset();
    }

    /// Sets DEVICE_NEEDS_RESET and raises the configuration interrupt.
    fn need_reset(&self, reason: &'static str) {
        self.interrupt.set_needs_reset();
        self.interrupt.raise_config();
        tracing::warn!(
            device = self.spec.name,
            reason,
            "virtio device needs a reset"
        );
    }

    /// Reports a device method error through the transport's error policy.
    fn handle_device_error(&self, error: DeviceError) {
        match error {
            DeviceError::NeedsReset(reason) => self.need_reset(reason),
            DeviceError::Fatal(reason) => self.send_device_failed(reason),
            DeviceError::Unsupported(reason) => {
                tracing::warn!(
                    device = self.spec.name,
                    reason,
                    "unsupported virtio device operation"
                );
            }
        }
    }

    /// Sends a fatal error to the run thread.
    fn send_device_failed(&self, reason: &'static str) {
        self.sender.send(Event::DeviceFailed(Error::VirtioDevice {
            device: self.spec.name,
            reason,
        }));
    }

    /// Reports a worker-control failure as fatal.
    fn report_worker_failure(&self, error: DeviceError) {
        let reason = match error {
            DeviceError::Fatal(reason)
            | DeviceError::NeedsReset(reason)
            | DeviceError::Unsupported(reason) => reason,
        };
        tracing::warn!(
            device = self.spec.name,
            reason,
            "virtio worker operation failed"
        );
        self.send_device_failed(reason);
    }

    /// Reads configuration space into `data`.
    fn read_config_space(&mut self, offset: u64, data: &mut [u8]) {
        if !self.config_in_range(offset, data.len()) {
            tracing::debug!(offset, len = data.len(), "ignoring a config read");
            return;
        }
        let result = self
            .device
            .lock()
            .expect("a virtio device lock is poisoned")
            .read_config(offset, data);
        if let Err(error) = result {
            self.handle_device_error(error);
        }
    }

    /// Writes configuration space from `data`.
    fn write_config_space(&mut self, offset: u64, data: &[u8]) {
        if !self.config_in_range(offset, data.len()) {
            tracing::debug!(offset, len = data.len(), "ignoring a config write");
            return;
        }
        let result = self
            .device
            .lock()
            .expect("a virtio device lock is poisoned")
            .write_config(offset, data);
        if let Err(error) = result {
            self.handle_device_error(error);
        }
    }

    /// Whether `[offset, offset + len)` lies in the declared config space.
    fn config_in_range(&self, offset: u64, len: usize) -> bool {
        offset
            .checked_add(len as u64)
            .is_some_and(|end| end <= self.spec.config_len as u64)
    }
}

impl BusDevice for MmioTransport {
    fn read(&mut self, offset: u64, data: &mut [u8]) {
        if offset < CONFIG_OFFSET {
            if data.len() != 4 || !offset.is_multiple_of(4) {
                tracing::debug!(
                    offset,
                    len = data.len(),
                    "ignoring an unsupported MMIO control read"
                );
                return;
            }
            let value = self.read_control(offset);
            data.copy_from_slice(&value.to_le_bytes());
            return;
        }
        if offset < MMIO_WINDOW_LEN {
            let relative = offset - CONFIG_OFFSET;
            match data.len() {
                1 | 2 | 4 => self.read_config_space(relative, data),
                8 => {
                    if self.config_in_range(relative, 8) {
                        let (low, high) = data.split_at_mut(4);
                        self.read_config_space(relative, low);
                        self.read_config_space(relative + 4, high);
                    } else {
                        tracing::debug!(offset, "ignoring an out-of-range config access");
                    }
                }
                len => tracing::debug!(offset, len, "ignoring an unsupported config width"),
            }
            return;
        }
        tracing::debug!(offset, len = data.len(), "ignoring an MMIO read");
    }

    fn write(&mut self, offset: u64, data: &[u8]) {
        if offset < CONFIG_OFFSET {
            let Ok(bytes) = <[u8; 4]>::try_from(data) else {
                tracing::debug!(
                    offset,
                    len = data.len(),
                    "ignoring an unsupported MMIO control write"
                );
                return;
            };
            if !offset.is_multiple_of(4) {
                tracing::debug!(offset, "ignoring an unaligned MMIO control write");
                return;
            }
            self.write_control(offset, u32::from_le_bytes(bytes));
            return;
        }
        if offset < MMIO_WINDOW_LEN {
            let relative = offset - CONFIG_OFFSET;
            match data.len() {
                1 | 2 | 4 => self.write_config_space(relative, data),
                8 => {
                    if self.config_in_range(relative, 8) {
                        let (low, high) = data.split_at(4);
                        self.write_config_space(relative, low);
                        self.write_config_space(relative + 4, high);
                    } else {
                        tracing::debug!(offset, "ignoring an out-of-range config access");
                    }
                }
                len => tracing::debug!(offset, len, "ignoring an unsupported config width"),
            }
            return;
        }
        tracing::debug!(offset, len = data.len(), "ignoring an MMIO write");
    }
}

/// A fresh queue shadow from the device's declared maxima.
fn fresh_queues(spec: &DeviceSpec) -> Vec<QueueConfig> {
    spec.queue_max
        .iter()
        .map(|&max| QueueConfig {
            size: u32::from(max),
            ..QueueConfig::default()
        })
        .collect()
}

// The file lives under `tests/` so the suite stays out of the crate's counted
// source; it is still a unit-test module with access to crate-private items.
#[cfg(test)]
#[path = "../../tests/virtio/mmio.rs"]
mod tests;
