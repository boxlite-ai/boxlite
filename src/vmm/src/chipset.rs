// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The machine's devices and the resources they hold.
//!
//! [`ChipsetBuilder`] is the one registry of port ranges, MMIO ranges and
//! interrupt lines, like OpenVMM's chipset builder. Platform code adds each
//! device by name with a closure that claims the device's resources from a
//! [`Resources`] handle; `build` returns an immutable [`Chipset`], or every
//! conflict at once, naming the claimant and the owner. The chipset owns the
//! devices and is shared by the vCPU threads, which dispatch exits to it.
//! Nothing adds a device after the build.

use std::{
    collections::{BTreeMap, btree_map::Entry},
    fmt,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use boxlite_hypervisor::VcpuExit;

use crate::{
    bus::{BusDevice, BusRange, Buses, Target},
    error::{Error, Result},
    events::EventSender,
    irq::{IrqChip, IrqLine},
};

/// Which address space a range lives in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BusKind {
    Mmio,
    #[cfg(target_arch = "x86_64")]
    Pio,
}

impl fmt::Display for BusKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Mmio => "MMIO",
            #[cfg(target_arch = "x86_64")]
            Self::Pio => "port",
        })
    }
}

/// A claim the builder rejected. `claimant` made the claim; `owner`, a device
/// or a reserved window, already owns the resource.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Conflict {
    /// The claimed range overlaps a range `owner` owns.
    RangeTaken {
        bus: BusKind,
        claimant: &'static str,
        base: u64,
        len: u64,
        owner: &'static str,
    },
    /// The claimed range is empty or wraps.
    InvalidRange {
        bus: BusKind,
        claimant: &'static str,
        base: u64,
        len: u64,
    },
    /// The claimed interrupt line is one `owner` owns.
    LineTaken {
        line: u32,
        claimant: &'static str,
        owner: &'static str,
    },
}

impl fmt::Display for Conflict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RangeTaken {
                bus,
                claimant,
                base,
                len,
                owner,
            } => write!(
                f,
                "{claimant} claims {bus} range {base:#x}+{len:#x}, held by {owner}"
            ),
            Self::InvalidRange {
                bus,
                claimant,
                base,
                len,
            } => write!(
                f,
                "{claimant} claims {bus} range {base:#x}+{len:#x}, which is empty or wraps"
            ),
            Self::LineTaken {
                line,
                claimant,
                owner,
            } => write!(
                f,
                "{claimant} claims interrupt line {line}, held by {owner}"
            ),
        }
    }
}

/// Wraps the host interrupt controller and refuses every `set_line` until
/// `build` arms it, so a device constructor cannot raise a line for a device
/// that a later conflict discards.
struct ArmableIrqChip {
    host: Arc<dyn IrqChip>,
    armed: AtomicBool,
}

impl IrqChip for ArmableIrqChip {
    fn set_line(&self, line: u32, level: bool) -> Result<()> {
        if !self.armed.load(Ordering::Acquire) {
            return Err(Error::LineNotArmed(line));
        }
        self.host.set_line(line, level)
    }
}

/// A claim of `len` addresses from `base` on `bus`. An access at `base + n`
/// reaches the device at offset `first_offset + n`.
struct RangeClaim {
    bus: BusKind,
    base: u64,
    len: u64,
    first_offset: u64,
}

/// The resources a device constructor claims. Claims are recorded, not
/// checked, so the builder can report every conflict at once.
pub(crate) struct Resources {
    irq_chip: Arc<ArmableIrqChip>,
    event_sender: EventSender,
    range_claims: Vec<RangeClaim>,
    line_claims: Vec<u32>,
}

impl Resources {
    /// Claims `len` ports from `base`; port `base` reaches the device at
    /// offset 0.
    #[cfg(target_arch = "x86_64")]
    pub(crate) fn pio(&mut self, base: u64, len: u64) {
        self.pio_with_offset(base, len, 0);
    }

    /// Claims `len` ports from `base`; port `base` reaches the device at
    /// offset `first_offset`. For a controller whose ports are split across
    /// several ranges.
    #[cfg(target_arch = "x86_64")]
    pub(crate) fn pio_with_offset(&mut self, base: u64, len: u64, first_offset: u64) {
        self.range_claims.push(RangeClaim {
            bus: BusKind::Pio,
            base,
            len,
            first_offset,
        });
    }

    /// Claims `len` bytes of MMIO from `base`; address `base` reaches the
    /// device at offset 0.
    pub(crate) fn mmio(&mut self, base: u64, len: u64) {
        self.range_claims.push(RangeClaim {
            bus: BusKind::Mmio,
            base,
            len,
            first_offset: 0,
        });
    }

    /// Claims interrupt `line`: a GSI on x86_64, an SPI on arm64. The device
    /// owns the returned line, which reaches the host only once `build` arms
    /// it; a second claim of the same line fails the build.
    pub(crate) fn line(&mut self, line: u32) -> IrqLine {
        self.line_claims.push(line);
        IrqLine::new(self.irq_chip.clone(), line)
    }

    /// The sender a device keeps to end the VM later. A constructor sends
    /// nothing.
    pub(crate) fn event_sender(&self) -> EventSender {
        self.event_sender.clone()
    }
}

/// Collects devices and their resources, then builds the [`Chipset`].
pub(crate) struct ChipsetBuilder {
    irq_chip: Arc<ArmableIrqChip>,
    event_sender: EventSender,
    buses: Buses,
    line_owners: BTreeMap<u32, &'static str>,
    devices: Vec<Arc<Mutex<dyn BusDevice>>>,
    conflicts: Vec<Conflict>,
}

impl ChipsetBuilder {
    /// A builder whose devices raise interrupts on `irq_chip` and end the VM
    /// through `event_sender`.
    pub(crate) fn new(irq_chip: Arc<dyn IrqChip>, event_sender: EventSender) -> Self {
        Self {
            irq_chip: Arc::new(ArmableIrqChip {
                host: irq_chip,
                armed: AtomicBool::new(false),
            }),
            event_sender,
            buses: Buses::default(),
            line_owners: BTreeMap::new(),
            devices: Vec::new(),
            conflicts: Vec::new(),
        }
    }

    /// Reserves a window the host serves in the kernel, such as KVM's PIT
    /// ports or the local APIC page, so no device can claim it. `owner`
    /// names the window in conflicts.
    pub(crate) fn reserve(&mut self, bus: BusKind, base: u64, len: u64, owner: &'static str) {
        self.insert_range(
            RangeClaim {
                bus,
                base,
                len,
                first_offset: 0,
            },
            owner,
            None,
        );
    }

    /// Adds the device `ctor` constructs, under `name`, with the resources
    /// it claims. The constructor only claims resources and builds state: a
    /// device that needs a thread starts it after [`build`](Self::build).
    /// Fails only when the constructor does; conflicts wait for `build`.
    pub(crate) fn add<D, F>(&mut self, name: &'static str, ctor: F) -> Result<()>
    where
        D: BusDevice + 'static,
        F: FnOnce(&mut Resources) -> Result<D>,
    {
        let mut resources = Resources {
            irq_chip: self.irq_chip.clone(),
            event_sender: self.event_sender.clone(),
            range_claims: Vec::new(),
            line_claims: Vec::new(),
        };
        let device: Arc<Mutex<dyn BusDevice>> = Arc::new(Mutex::new(ctor(&mut resources)?));
        for claim in resources.range_claims {
            let target = (Arc::clone(&device), claim.first_offset);
            self.insert_range(claim, name, Some(target));
        }
        for line in resources.line_claims {
            // A rejected claim leaves the line with its first owner.
            match self.line_owners.entry(line) {
                Entry::Vacant(slot) => {
                    slot.insert(name);
                }
                Entry::Occupied(owner) => self.conflicts.push(Conflict::LineTaken {
                    line,
                    claimant: name,
                    owner: owner.get(),
                }),
            }
        }
        self.devices.push(device);
        Ok(())
    }

    /// Arms every line and returns the chipset, or returns every conflict;
    /// on a conflict the devices drop without having run.
    pub(crate) fn build(self) -> Result<Chipset> {
        if !self.conflicts.is_empty() {
            return Err(Error::ChipsetConflicts(self.conflicts));
        }
        self.irq_chip.armed.store(true, Ordering::Release);
        Ok(Chipset {
            buses: self.buses,
            _devices: self.devices,
        })
    }

    /// Puts the claimed range on its bus, owned by `claimant`, or records why
    /// it cannot go there. `target` is `None` for a reserved window.
    fn insert_range(&mut self, claim: RangeClaim, claimant: &'static str, target: Option<Target>) {
        let Some(range) = BusRange::new(claim.base, claim.len) else {
            self.conflicts.push(Conflict::InvalidRange {
                bus: claim.bus,
                claimant,
                base: claim.base,
                len: claim.len,
            });
            return;
        };
        let bus = match claim.bus {
            BusKind::Mmio => &mut self.buses.mmio,
            #[cfg(target_arch = "x86_64")]
            BusKind::Pio => &mut self.buses.pio,
        };
        if let Err(owner) = bus.insert(range, claimant, target) {
            self.conflicts.push(Conflict::RangeTaken {
                bus: claim.bus,
                claimant,
                base: claim.base,
                len: claim.len,
                owner,
            });
        }
    }
}

/// The built machine: its buses and the devices behind them. Every vCPU
/// thread borrows it for the run.
pub(crate) struct Chipset {
    buses: Buses,
    /// Every device, kept alive for the chipset's lifetime; the buses hold
    /// the same references.
    _devices: Vec<Arc<Mutex<dyn BusDevice>>>,
}

impl Chipset {
    /// Serves an MMIO or port access and returns `None`; returns every other
    /// exit to the caller unchanged.
    pub(crate) fn dispatch<'a>(&self, exit: VcpuExit<'a>) -> Option<VcpuExit<'a>> {
        self.buses.dispatch(exit)
    }

    /// The buses, whose counters show the accesses no device claimed.
    pub(crate) fn buses(&self) -> &Buses {
        &self.buses
    }
}

#[cfg(test)]
#[path = "../tests/chipset/mod.rs"]
mod tests;
