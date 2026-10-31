// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Bus ranges, registration and dispatch, driven by a recording device. The
//! range and overlap cases follow Firecracker's `vstate/bus.rs` tests.

use std::{
    panic::{self, AssertUnwindSafe},
    sync::{Arc, Mutex},
};

use boxlite_hypervisor::VcpuExit;

use super::{
    Bus, BusDevice, BusIo, BusRange, BusRead, BusWrite, Buses, Dispatch, PendingIo, UNCLAIMED_READ,
};
use crate::io::{Completer, Completion, ConfigBytes};

/// One access a device saw: whether it was a write, its offset and its bytes.
type Access = (bool, u64, Vec<u8>);

/// Records every access and answers a read by setting only its first byte to
/// `reply`. A write of `PANIC` panics while the device lock is held.
#[derive(Default)]
struct Recorder {
    accesses: Vec<Access>,
    reply: u8,
}

const PANIC: u8 = 0xEE;

impl BusDevice for Recorder {
    fn read(&mut self, offset: u64, len: usize) -> BusIo<ConfigBytes> {
        // The hypervisor hands the device an empty buffer; a read that fills
        // only the first byte leaves the rest zeroed.
        self.accesses.push((false, offset, vec![0; len]));
        let mut bytes = vec![0; len];
        if let Some(first) = bytes.first_mut() {
            *first = self.reply;
        }
        BusIo::Complete(ConfigBytes::from_slice(&bytes))
    }

    fn write(&mut self, offset: u64, data: &[u8]) -> BusIo<()> {
        self.accesses.push((true, offset, data.to_vec()));
        assert_ne!(data, [PANIC], "the device panics as asked");
        BusIo::Complete(())
    }
}

fn recorder(reply: u8) -> Arc<Mutex<Recorder>> {
    Arc::new(Mutex::new(Recorder {
        reply,
        ..Recorder::default()
    }))
}

fn insert(
    bus: &mut Bus,
    base: u64,
    len: u64,
    owner: &'static str,
    device: &Arc<Mutex<Recorder>>,
) -> Result<(), &'static str> {
    let device: Arc<Mutex<dyn BusDevice>> = device.clone();
    bus.insert(
        BusRange::new(base, len).expect("a valid range"),
        owner,
        Some((device, 0)),
    )
}

fn accesses(device: &Arc<Mutex<Recorder>>) -> Vec<Access> {
    device.lock().unwrap().accesses.clone()
}

/// Reads through a bus whose device answers at once.
fn read(bus: &Bus, addr: u64, len: usize) -> ConfigBytes {
    match bus.read(addr, len) {
        BusRead::Complete(bytes) => bytes,
        BusRead::Deferred(_) => panic!("the recorder answers at once"),
    }
}

/// Writes through a bus whose device answers at once.
fn write(bus: &Bus, addr: u64, data: &[u8]) {
    assert!(
        matches!(bus.write(addr, data), BusWrite::Complete),
        "the recorder answers at once"
    );
}

#[test]
fn a_range_is_non_empty_and_does_not_wrap() {
    assert!(BusRange::new(0x10, 0).is_none());
    assert!(BusRange::new(u64::MAX, 2).is_none());
    assert!(BusRange::new(2, u64::MAX).is_none());
    let last = BusRange::new(u64::MAX, 1).unwrap();
    assert!(last.holds(u64::MAX, 1));
    assert!(!last.holds(u64::MAX - 1, 1));
    assert!(!last.holds(u64::MAX, 2), "an access past the end wraps");
    let whole = BusRange::new(0, u64::MAX).unwrap();
    assert!(whole.holds(0, 8) && whole.holds(u64::MAX - 1, 1));
    assert!(!whole.holds(u64::MAX, 1), "the last address is outside");
}

#[test]
fn insert_rejects_every_overlap_naming_its_holder_and_accepts_neighbours() {
    let mut bus = Bus::default();
    let device = recorder(0);
    insert(&mut bus, 0x100, 0x10, "first", &device).unwrap();

    for (base, len) in [
        (0x100, 0x10), // the same range
        (0x100, 0x1),  // the same base
        (0xF8, 0x10),  // reaches in from below
        (0x108, 0x10), // reaches out above
        (0xF0, 0x40),  // encloses it
        (0x104, 0x4),  // lies inside it
        (0x10F, 0x1),  // its last address
    ] {
        assert_eq!(
            insert(&mut bus, base, len, "second", &device),
            Err("first"),
            "{base:#x}+{len:#x}"
        );
    }
    insert(&mut bus, 0xF0, 0x10, "below", &device).unwrap();
    insert(&mut bus, 0x110, 0x10, "above", &device).unwrap();
    insert(&mut bus, u64::MAX, 1, "last", &device).unwrap();
    assert_eq!(
        insert(&mut bus, 0x118, 0x100, "wide", &device),
        Err("above")
    );
}

#[test]
fn accesses_reach_the_device_at_their_offset_with_reads_zeroed() {
    let mut bus = Bus::default();
    let device = recorder(0x60);
    insert(&mut bus, 0x3f8, 8, "com1", &device).unwrap();

    write(&bus, 0x3fb, &[0x80]);
    let lsr = read(&bus, 0x3fd, 1);
    let wide = read(&bus, 0x3f8, 4);

    assert_eq!(lsr.as_slice(), [0x60]);
    assert_eq!(
        wide.as_slice(),
        [0x60, 0, 0, 0],
        "bytes the device leaves are zero"
    );
    assert_eq!(
        accesses(&device),
        [
            (true, 3, vec![0x80]),
            (false, 5, vec![0]),
            (false, 0, vec![0; 4]),
        ]
    );
    assert_eq!(bus.unclaimed(), (0, 0));
}

/// A controller whose ports are not contiguous registers them as separate
/// ranges, each with the register offset the device expects there.
#[test]
fn a_range_can_start_at_a_register_offset() {
    let mut bus = Bus::default();
    let device = recorder(0);
    let shared: Arc<Mutex<dyn BusDevice>> = device.clone();
    bus.insert(
        BusRange::new(0x60, 1).unwrap(),
        "i8042",
        Some((shared.clone(), 0)),
    )
    .unwrap();
    bus.insert(BusRange::new(0x64, 1).unwrap(), "i8042", Some((shared, 4)))
        .unwrap();

    write(&bus, 0x60, &[1]);
    write(&bus, 0x64, &[0xFE]);
    let data = read(&bus, 0x61, 1);

    assert_eq!(
        accesses(&device),
        [(true, 0, vec![1]), (true, 4, vec![0xFE])]
    );
    assert_eq!(data.as_slice(), [UNCLAIMED_READ], "0x61 is nobody's");
}

#[test]
fn unclaimed_and_partial_accesses_read_all_ones_skip_the_device_and_count() {
    let mut bus = Bus::default();
    let device = recorder(0x60);
    insert(&mut bus, 0x3f8, 8, "com1", &device).unwrap();

    let cases = [
        (0x2f8, 1), // no device
        (0x3fe, 4), // runs past the range end
        (0x3f7, 2), // starts below the range
        (0x400, 1), // just above the range
        (0x3f8, 0), // empty
    ];
    for (addr, len) in cases {
        let data = read(&bus, addr, len);
        assert_eq!(
            data.as_slice(),
            &vec![UNCLAIMED_READ; len][..],
            "read {addr:#x}+{len}"
        );
        write(&bus, addr, data.as_slice());
    }
    assert!(accesses(&device).is_empty());
    assert_eq!(bus.unclaimed(), (cases.len() as u64, cases.len() as u64));
}

/// A window the host serves in the kernel never reaches a device; should an
/// access arrive anyway, it is unclaimed.
#[test]
fn a_reserved_window_takes_no_device_and_is_unclaimed() {
    let mut bus = Bus::default();
    let device = recorder(0x42);
    bus.insert(BusRange::new(0x40, 4).unwrap(), "in-kernel PIT", None)
        .unwrap();

    assert_eq!(
        insert(&mut bus, 0x42, 1, "intruder", &device),
        Err("in-kernel PIT")
    );
    let data = read(&bus, 0x40, 1);
    assert_eq!(data.as_slice(), [UNCLAIMED_READ]);
    assert_eq!(bus.unclaimed(), (1, 0));
}

/// A device that panicked poisoned its lock; the next access stops as well
/// instead of reading registers the panic left half-written.
#[test]
fn an_access_after_a_device_panicked_stops_too() {
    let mut bus = Bus::default();
    let device = recorder(0x42);
    insert(&mut bus, 0x60, 1, "i8042", &device).unwrap();

    let first = panic::catch_unwind(AssertUnwindSafe(|| bus.write(0x60, &[PANIC])));
    let second = panic::catch_unwind(AssertUnwindSafe(|| bus.read(0x60, 1)));

    assert!(first.is_err());
    assert!(device.is_poisoned());
    assert!(second.is_err(), "a poisoned device must not answer");
}

/// A device that answers later hands the bus a readiness completion; the
/// default progress completes the access without bytes, which reads as zeros.
struct Defers {
    readiness: Option<Completer<()>>,
}

impl BusDevice for Defers {
    fn read(&mut self, _offset: u64, _len: usize) -> BusIo<ConfigBytes> {
        let (completion, completer) = Completion::new();
        self.readiness = Some(completer);
        BusIo::Deferred(completion)
    }

    fn write(&mut self, _offset: u64, _data: &[u8]) -> BusIo<()> {
        let (completion, completer) = Completion::new();
        self.readiness = Some(completer);
        BusIo::Deferred(completion)
    }
}

#[test]
fn a_deferred_read_keeps_its_completion_and_completes_through_progress() {
    let mut buses = Buses::default();
    let device = Arc::new(Mutex::new(Defers { readiness: None }));
    let shared: Arc<Mutex<dyn BusDevice>> = device;
    buses
        .mmio
        .insert(
            BusRange::new(0x1000, 0x10).unwrap(),
            "virtio",
            Some((shared, 0)),
        )
        .unwrap();

    let mut data = [0; 4];
    let Dispatch::DeferredRead {
        mut exit,
        completion,
        io,
    } = buses.dispatch(VcpuExit::MmioRead {
        guest_addr: 0x1000,
        bytes: &mut data,
    })
    else {
        panic!("the device defers its read");
    };
    assert!(!completion.is_done());
    assert!(
        !io.readiness().is_done(),
        "the device has not reported readiness"
    );
    match &mut exit {
        VcpuExit::MmioRead { guest_addr, .. } => assert_eq!(*guest_addr, 0x1000),
        _ => panic!("a deferred read carries a read exit"),
    }
    let mut request = io.request();
    assert!(matches!(&request, PendingIo::Read { len: 4, .. }));
    {
        let mut target = io.lock_target().expect("the device is not poisoned");
        assert!(matches!(target.progress(&mut request), BusIo::Complete(())));
    }
    assert!(io.complete(request));
    assert_eq!(completion.wait().unwrap().as_slice(), [0; 4]);
}

#[test]
fn a_deferred_write_hands_back_the_data_it_deferred() {
    let mut buses = Buses::default();
    let device = Arc::new(Mutex::new(Defers { readiness: None }));
    let shared: Arc<Mutex<dyn BusDevice>> = device;
    buses
        .mmio
        .insert(
            BusRange::new(0x1000, 0x10).unwrap(),
            "virtio",
            Some((shared, 0)),
        )
        .unwrap();

    let Dispatch::DeferredWrite { completion, io } = buses.dispatch(VcpuExit::MmioWrite {
        guest_addr: 0x1004,
        bytes: &[9, 8],
    }) else {
        panic!("the device defers its write");
    };
    assert!(!io.readiness().is_done());
    let mut request = io.request();
    let PendingIo::Write { offset, data } = &request else {
        panic!("the device defers its write");
    };
    assert_eq!(*offset, 4);
    assert_eq!(data.as_slice(), [9, 8].as_slice());
    {
        let mut target = io.lock_target().expect("the device is not poisoned");
        target.progress(&mut request);
    }
    assert!(io.complete(request));
    assert_eq!(completion.wait(), Ok(()));
}

#[test]
fn dispatch_serves_io_exits_and_returns_the_rest() {
    let mut buses = Buses::default();
    let mmio = recorder(0x11);
    insert(&mut buses.mmio, 0x1000, 0x10, "virtio", &mmio).unwrap();

    let mut read_data = [0; 4];
    assert!(matches!(
        buses.dispatch(VcpuExit::MmioRead {
            guest_addr: 0x1004,
            bytes: &mut read_data,
        }),
        Dispatch::Handled
    ));
    assert!(matches!(
        buses.dispatch(VcpuExit::MmioWrite {
            guest_addr: 0x1008,
            bytes: &[7, 8],
        }),
        Dispatch::Handled
    ));
    assert_eq!(read_data, [0x11, 0, 0, 0]);
    assert_eq!(
        accesses(&mmio),
        [(false, 4, vec![0; 4]), (true, 8, vec![7, 8])]
    );

    assert!(matches!(
        buses.dispatch(VcpuExit::Interrupted),
        Dispatch::Passthrough(VcpuExit::Interrupted)
    ));
    assert!(matches!(
        buses.dispatch(VcpuExit::Halted),
        Dispatch::Passthrough(VcpuExit::Halted)
    ));
    assert!(matches!(
        buses.dispatch(VcpuExit::Shutdown),
        Dispatch::Passthrough(VcpuExit::Shutdown)
    ));
    assert!(matches!(
        buses.dispatch(VcpuExit::Reset),
        Dispatch::Passthrough(VcpuExit::Reset)
    ));
}

/// Port and MMIO addresses are separate spaces: the same number reaches a
/// different device on each bus.
#[cfg(target_arch = "x86_64")]
#[test]
fn ports_and_mmio_are_separate_address_spaces() {
    let mut buses = Buses::default();
    let mmio = recorder(0x11);
    let pio = recorder(0x22);
    insert(&mut buses.mmio, 0x60, 1, "mmio", &mmio).unwrap();
    insert(&mut buses.pio, 0x60, 1, "pio", &pio).unwrap();

    let mut port = [0];
    assert!(matches!(
        buses.dispatch(VcpuExit::IoIn {
            port: 0x60,
            bytes: &mut port,
        }),
        Dispatch::Handled
    ));
    assert!(matches!(
        buses.dispatch(VcpuExit::IoOut {
            port: 0x60,
            bytes: &[0xFE],
        }),
        Dispatch::Handled
    ));

    assert_eq!(port, [0x22]);
    assert_eq!(accesses(&pio), [(false, 0, vec![0]), (true, 0, vec![0xFE])]);
    assert!(accesses(&mmio).is_empty());
}

#[test]
fn buses_are_shared_across_vcpu_threads() {
    fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<Buses>();
}

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[path = "kvm.rs"]
mod kvm;
