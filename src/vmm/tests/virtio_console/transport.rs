// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The console device behind the real virtio-mmio transport: register
//! discovery, feature negotiation, queue activation, notify, TX completion,
//! interrupt and Status=0 reset. A fake worker stands in for the shared
//! executor and dispatches no events itself.

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicUsize, Ordering},
};

use virtio_queue::desc::split::Descriptor;
use vm_memory::{Bytes, GuestAddress};

use super::{Registrar, Taken};
use crate::{
    bus::BusDevice,
    devices::{console::ConsoleWorker, virtio_console::VirtioConsole},
    events::EventLoop,
    irq::IrqLine,
    memory::GuestMemoryMmap,
    mock_vm::MockVm,
    virtio::{
        DeviceEvent, VirtioDevice, VirtioInterrupt, WorkerContext, WorkerControl,
        interrupt::MmioInterrupt,
        mmio::{MmioResources, MmioTransport},
    },
};

const MAX_SIZE: u16 = 256;
const SIZE: u16 = 8;
const DESC: u64 = 0x4000;
const AVAIL: u64 = 0x5000;
const USED: u64 = 0x6000;
const DATA: u64 = 0x10000;

#[derive(Default)]
struct FakeWorker {
    starts: AtomicUsize,
    stops: AtomicUsize,
    kicks: Mutex<Vec<u16>>,
}

impl WorkerControl for FakeWorker {
    fn prepare(&self) -> Result<WorkerContext, crate::virtio::DeviceError> {
        Ok(WorkerContext {
            events: Arc::new(Registrar),
            waker: Arc::new(|| {}),
        })
    }

    fn start(&self) -> Result<(), crate::virtio::DeviceError> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn kick(&self, index: u16) {
        self.kicks.lock().unwrap().push(index);
    }

    fn stop(&self) -> Result<(), crate::virtio::DeviceError> {
        self.stops.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    fn cancel_prepare(&self) {}
}

/// Writes one 4-byte control register.
fn control(transport: &mut MmioTransport, offset: u64, value: u32) {
    transport.write(offset, &value.to_le_bytes());
}

/// Reads one 4-byte control register.
fn register(transport: &mut MmioTransport, offset: u64) -> u32 {
    let mut bytes = [0; 4];
    transport.read(offset, &mut bytes);
    u32::from_le_bytes(bytes)
}

/// Publishes one read-only TX chain on the configured queue.
fn queue_ready(memory: &GuestMemoryMmap) {
    memory
        .write_obj(Descriptor::new(DATA, 5, 0, 0), GuestAddress(DESC))
        .unwrap();
    memory.write_slice(b"hello", GuestAddress(DATA)).unwrap();
    memory.write_obj(0u16.to_le(), GuestAddress(AVAIL)).unwrap();
    memory
        .write_obj(1u16.to_le(), GuestAddress(AVAIL + 2))
        .unwrap();
    memory
        .write_obj(0u16.to_le(), GuestAddress(AVAIL + 4))
        .unwrap();
}

#[test]
fn the_transport_discovers_tx_only_console_and_resets_it() {
    let memory = Arc::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x20000)]).unwrap());
    let interrupt = Arc::new(MmioInterrupt::new(IrqLine::new(Arc::new(MockVm::new()), 5)));
    let worker = Arc::new(FakeWorker::default());
    let events = EventLoop::new().unwrap();
    let taken = Taken::default();
    let (writer, mut console_worker) = ConsoleWorker::spawn(Box::new(taken.clone()), 64).unwrap();
    let device: Arc<Mutex<dyn VirtioDevice>> = Arc::new(Mutex::new(VirtioConsole::new(writer)));
    let mut transport = MmioTransport::new(
        Arc::clone(&device),
        Arc::clone(&interrupt),
        MmioResources {
            memory: Arc::clone(&memory),
            sender: events.sender(),
            worker: Arc::clone(&worker) as Arc<dyn WorkerControl>,
        },
    )
    .unwrap();

    assert_eq!(register(&mut transport, 0x008), 3);
    assert_eq!(register(&mut transport, 0x010), 0);
    control(&mut transport, 0x014, 1);
    assert_eq!(register(&mut transport, 0x010), 1 << 0);
    control(&mut transport, 0x014, 0);
    assert_eq!(register(&mut transport, 0x034), u32::from(MAX_SIZE));

    control(&mut transport, 0x070, 0x3);
    control(&mut transport, 0x024, 1);
    control(&mut transport, 0x020, 1);
    control(&mut transport, 0x070, 0xb);
    control(&mut transport, 0x030, 1);
    control(&mut transport, 0x038, u32::from(SIZE));
    control(&mut transport, 0x080, DESC as u32);
    control(&mut transport, 0x090, AVAIL as u32);
    control(&mut transport, 0x0a0, USED as u32);
    control(&mut transport, 0x044, 1);
    control(&mut transport, 0x070, 0xf);

    assert_eq!(register(&mut transport, 0x070), 0xf);
    assert_eq!(worker.starts.load(Ordering::SeqCst), 1);
    let mut config = [0xaa; 12];
    let (low, high) = config.split_at_mut(8);
    transport.read(0x100, low);
    transport.read(0x108, high);
    assert_eq!(config, [0; 12]);

    control(&mut transport, 0x050, 1);
    assert_eq!(*worker.kicks.lock().unwrap(), [1]);
    queue_ready(&memory);
    device
        .lock()
        .unwrap()
        .on_event(DeviceEvent::QueueKick(1))
        .unwrap();

    assert_eq!(
        u16::from_le(memory.read_obj::<u16>(GuestAddress(USED + 2)).unwrap()),
        1
    );
    let used = memory.read_obj::<u64>(GuestAddress(USED + 4)).unwrap();
    assert_eq!(used, 0);
    assert_eq!(interrupt.interrupt_status(), 1);
    console_worker.finish();
    assert_eq!(taken.bytes(), b"hello");

    control(&mut transport, 0x070, 0);
    assert_eq!(register(&mut transport, 0x070), 0);
    assert_eq!(worker.stops.load(Ordering::SeqCst), 1);
    assert_eq!(interrupt.interrupt_status(), 0);
    device
        .lock()
        .unwrap()
        .on_event(DeviceEvent::QueueKick(1))
        .unwrap();
    assert_eq!(
        u16::from_le(memory.read_obj::<u16>(GuestAddress(USED + 2)).unwrap()),
        1
    );
}
