// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The devices behind the buses, and the platform code that adds them.

pub(crate) mod balloon;
pub(crate) mod console;
#[cfg(target_arch = "x86_64")]
pub(crate) mod i8042;
#[cfg(unix)]
pub(crate) mod net;
#[cfg(target_arch = "x86_64")]
pub(crate) mod serial;
pub(crate) mod virtio_console;
#[cfg(target_arch = "x86_64")]
pub(crate) mod x86_64;

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
use std::sync::{Arc, Mutex};

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
use self::{console::ConsoleWriter, x86_64::add_legacy_devices};
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
use crate::{
    chipset::ChipsetBuilder,
    config::VmConfig,
    error::Result,
    memory::ReclaimPolicy,
    virtio::{
        DeviceContext, blk, fs,
        mmio::{self, Slot, Slots},
    },
};

/// Adds every device the configuration names, in slot order: the legacy
/// platform devices, disks, reporting balloon, and optional filesystem,
/// vsock, network and console. The returned console stays available for the
/// final TX drain after the device workers stop.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
pub(crate) fn add_all(
    chipset: &mut ChipsetBuilder,
    ctx: DeviceContext<'_>,
    config: &mut VmConfig,
    console: ConsoleWriter,
) -> Result<Option<Arc<Mutex<virtio_console::VirtioConsole>>>> {
    add_legacy_devices(chipset, console.clone())?;

    let mut slots = Slots::new();
    let mut used = Vec::new();
    for (index, disk) in config.disks.iter().enumerate() {
        add_slot_device(&mut slots, &mut used, |slot| {
            blk::add_disk(chipset, &ctx, disk, index, slot)
        })?;
    }
    // The balloon follows the disks so it never renumbers them: the guest
    // names virtio devices by slot order, so adding it ahead of storage would
    // move every disk to a higher index.
    add_slot_device(&mut slots, &mut used, |slot| {
        crate::devices::balloon::add(chipset, &ctx, slot, ReclaimPolicy::default())
    })?;
    if let Some(filesystem) = &config.filesystem {
        add_slot_device(&mut slots, &mut used, |slot| {
            fs::add_filesystem(chipset, &ctx, filesystem, slot)
        })?;
    }
    if let Some(vsock) = &config.vsock {
        let device = crate::virtio::vsock::Vsock::bind(vsock).map_err(crate::Error::Vsock)?;
        add_slot_device(&mut slots, &mut used, |slot| {
            mmio::add_device(chipset, &ctx, "vsock", slot, Arc::new(Mutex::new(device)))
        })?;
    }
    if let Some(network) = &config.network {
        let device = net::Net::new(network.path.clone(), network.mac);
        add_slot_device(&mut slots, &mut used, |slot| {
            mmio::add_device(
                chipset,
                &ctx,
                "virtio-net",
                slot,
                Arc::new(Mutex::new(device)),
            )
        })?;
    }
    let mut console_device = None;
    if config.virtio_console {
        let device = Arc::new(Mutex::new(virtio_console::VirtioConsole::new(console)));
        console_device = Some(device.clone());
        add_slot_device(&mut slots, &mut used, |slot| {
            mmio::add_device(chipset, &ctx, "virtio-console", slot, device)
        })?;
    }
    // The next device is one more `add_slot_device` line here. A device that
    // must keep slot 0 goes before the disk loop.
    mmio::announce(&mut config.cmdline, &used)?;
    Ok(console_device)
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
