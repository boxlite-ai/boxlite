// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The devices behind the buses, and the platform code that adds them.

pub(crate) mod balloon;
pub(crate) mod console;
#[cfg(target_arch = "x86_64")]
pub(crate) mod i8042;
#[cfg(unix)]
#[cfg_attr(not(test), expect(dead_code, reason = "Awaiting VM wiring"))]
pub(crate) mod net;
#[cfg(target_arch = "x86_64")]
pub(crate) mod serial;
#[cfg_attr(not(test), expect(dead_code, reason = "VM wiring follows separately."))]
pub(crate) mod virtio_console;
#[cfg(target_arch = "x86_64")]
pub(crate) mod x86_64;

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
use self::{console::ConsoleWriter, x86_64::add_legacy_devices};
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
use crate::{
    chipset::ChipsetBuilder,
    config::VmConfig,
    error::Result,
    memory::ReclaimPolicy,
    virtio::{
        DeviceContext, blk,
        mmio::{self, Slot, Slots},
    },
};

/// Adds every device the configuration names, in slot order: the reporting
/// balloon first, then the legacy platform devices and one block per
/// configured disk. Adding a device is one `add_slot_device` line here;
/// [`crate::vm`] stays unchanged.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub(crate) fn add_all(
    chipset: &mut ChipsetBuilder,
    ctx: DeviceContext<'_>,
    config: &mut VmConfig,
    console: ConsoleWriter,
) -> Result<()> {
    add_legacy_devices(chipset, console)?;

    let mut slots = Slots::new();
    let mut used = Vec::new();
    // The reporting device goes first, so it keeps the design's fixed
    // `0xd0000000`/GSI 5 window instead of following the disks.
    add_slot_device(&mut slots, &mut used, |slot| {
        crate::devices::balloon::add(chipset, &ctx, slot, ReclaimPolicy::default())
    })?;
    for (index, disk) in config.disks.iter().enumerate() {
        add_slot_device(&mut slots, &mut used, |slot| {
            blk::add_disk(chipset, &ctx, disk, index, slot)
        })?;
    }
    // The next device is one more `add_slot_device` line here. A device that
    // must keep slot 0 goes before this loop.
    mmio::announce(&mut config.cmdline, &used)?;
    Ok(())
}

/// Takes the next slot, runs `attach` with it, and records it for
/// [`mmio::announce`]; a failed attach fails the build.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
fn add_slot_device(
    slots: &mut Slots,
    used: &mut Vec<Slot>,
    attach: impl FnOnce(Slot) -> Result<()>,
) -> Result<()> {
    let slot = slots.take()?;
    attach(slot)?;
    used.push(slot);
    Ok(())
}

#[cfg(all(test, target_os = "linux", target_arch = "x86_64"))]
mod tests {
    use super::add_slot_device;
    use crate::{
        error::Error,
        virtio::mmio::{Slot, Slots},
    };

    #[test]
    fn slot_devices_are_recorded_in_order_and_stop_at_capacity() {
        let mut slots = Slots::new();
        let mut used = Vec::new();
        add_slot_device(&mut slots, &mut used, |slot| {
            assert_eq!(
                slot,
                Slot {
                    base: 0xd000_0000,
                    gsi: 5
                }
            );
            Ok(())
        })
        .unwrap();
        assert_eq!(
            used,
            vec![Slot {
                base: 0xd000_0000,
                gsi: 5
            }]
        );

        for _ in 1..Slots::CAPACITY {
            add_slot_device(&mut slots, &mut used, |_| Ok(())).unwrap();
        }
        assert_eq!(used.len() as u32, Slots::CAPACITY);
        let error = add_slot_device(&mut slots, &mut used, |_| Ok(())).unwrap_err();
        assert!(matches!(error, Error::VirtioSlotsExhausted));
    }
}
