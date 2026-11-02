// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! virtio-blk contract tests: config, activation, request execution and the
//! shared queue adapter integration.

use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU8, AtomicUsize, Ordering},
    },
};

use tempfile::{TempDir, tempdir};
use virtio_queue::{Queue, QueueT, desc::split::Descriptor};
use vm_memory::{Bytes, GuestAddress};

use super::{
    DEVICE_ID, QUEUE_MAX, QUEUE_MAXIMUM, SECTOR_SIZE, VIRTIO_BLK_F_DISCARD, VIRTIO_BLK_F_FLUSH,
    VIRTIO_BLK_F_RO, VIRTIO_BLK_F_WRITE_ZEROES, VIRTIO_BLK_S_IOERR, VIRTIO_BLK_S_OK,
    VIRTIO_BLK_S_UNSUPP, VIRTIO_BLK_T_DISCARD, VIRTIO_BLK_T_FLUSH, VIRTIO_BLK_T_IN,
    VIRTIO_BLK_T_OUT, VIRTIO_BLK_T_WRITE_ZEROES, VIRTIO_BLK_WRITE_ZEROES_FLAG_UNMAP,
    VIRTIO_F_VERSION_1, VIRTIO_RING_F_EVENT_IDX, backend::BlkBackend, device::VirtioBlk,
};
use crate::{
    events::EventLoop,
    memory::GuestMemoryMmap,
    virtio::{
        ActivationContext, DeviceError, DeviceEvent, EventError, EventRegistrar, EventSource,
        FeatureError, SnapshotSupport, SourceId, VirtioDevice, VirtioInterrupt,
    },
};

const SIZE: u16 = 8;
const DESC: u64 = 0x4000;
const AVAIL: u64 = 0x5000;
const USED: u64 = 0x6000;
const HEADER: u64 = 0x1000;
const DATA: u64 = 0x2000;
const STATUS: u64 = 0x3000;
const PAYLOAD: u64 = 0x3800;
const NEXT: u16 = 1;
const WRITE: u16 = 2;
const INDIRECT: u16 = 4;
const FILE_SIZE: u64 = 1 << 20;
const CONFIG_LEN: usize = 60;

struct Fixture {
    _dir: TempDir,
    path: PathBuf,
    blk: VirtioBlk,
    memory: Arc<GuestMemoryMmap>,
    interrupt: Arc<TestInterrupt>,
}

impl Fixture {
    fn new(read_only: bool) -> Self {
        let dir = tempdir().unwrap();
        let path = dir.path().join("disk.raw");
        let mut file = File::create(&path).unwrap();
        file.set_len(FILE_SIZE).unwrap();
        for (sector, byte) in [(0u64, 0xAAu8), (16, 0xCC), (32, 0xDD), (48, 0xEE)] {
            file.seek(SeekFrom::Start(sector * SECTOR_SIZE)).unwrap();
            file.write_all(&[byte; 16 * 512]).unwrap();
        }
        drop(file);

        let backend = BlkBackend::open(&path, read_only).unwrap();
        let mut blk = VirtioBlk::new(backend);
        let features = blk.spec().features & !VIRTIO_RING_F_EVENT_IDX;
        blk.set_features(features).unwrap();

        let memory = Arc::new(memory());
        let interrupt = Arc::new(TestInterrupt::default());
        let interrupt_port: Arc<dyn VirtioInterrupt> = interrupt.clone();
        blk.activate(ActivationContext {
            memory: Arc::clone(&memory),
            queues: vec![ready_queue()],
            interrupt: interrupt_port,
            events: Arc::new(TestRegistrar),
            waker: Arc::new(|| {}),
            sender: EventLoop::new().unwrap().sender(),
        })
        .unwrap();

        Self {
            _dir: dir,
            path,
            blk,
            memory,
            interrupt,
        }
    }

    fn kick(&mut self) -> Result<(), DeviceError> {
        self.blk.on_event(DeviceEvent::QueueKick(0))
    }

    fn status(&self) -> u8 {
        self.memory.read_obj(GuestAddress(STATUS)).unwrap()
    }

    fn data(&self, len: usize) -> Vec<u8> {
        let mut data = vec![0u8; len];
        self.memory
            .read_slice(&mut data, GuestAddress(DATA))
            .unwrap();
        data
    }

    fn used(&self) -> (u16, u32, u32) {
        let index: u16 = self.memory.read_obj(GuestAddress(USED + 2)).unwrap();
        let id: u32 = self.memory.read_obj(GuestAddress(USED + 4)).unwrap();
        let len: u32 = self.memory.read_obj(GuestAddress(USED + 8)).unwrap();
        (index, id, len)
    }

    fn file_at(&self, offset: u64, len: usize) -> Vec<u8> {
        let mut file = File::open(&self.path).unwrap();
        file.seek(SeekFrom::Start(offset)).unwrap();
        let mut data = vec![0u8; len];
        file.read_exact(&mut data).unwrap();
        data
    }
}

#[derive(Default)]
struct TestInterrupt {
    raised: AtomicUsize,
    status: AtomicU8,
}

impl TestInterrupt {
    fn raised(&self) -> usize {
        self.raised.load(Ordering::SeqCst)
    }
}

impl VirtioInterrupt for TestInterrupt {
    fn raise(&self) {
        self.raised.fetch_add(1, Ordering::SeqCst);
    }

    fn interrupt_status(&self) -> u8 {
        self.status.load(Ordering::SeqCst)
    }

    fn ack_interrupt(&self, bits: u8) {
        self.status.fetch_and(!bits, Ordering::SeqCst);
    }

    fn config_generation(&self) -> u8 {
        0
    }

    fn raise_config(&self) {}

    fn device_status(&self) -> u8 {
        0
    }

    fn set_device_status(&self, _status: u8) {}
}

struct TestRegistrar;

impl EventRegistrar for TestRegistrar {
    fn register(
        &self,
        _event: DeviceEvent,
        _source: Box<dyn EventSource>,
    ) -> Result<SourceId, EventError> {
        Ok(SourceId(0))
    }

    fn deregister(&self, _id: SourceId) {}
}

fn memory() -> GuestMemoryMmap {
    GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x10000)]).unwrap()
}

fn ready_queue() -> Queue {
    let mut queue = Queue::new(QUEUE_MAX).unwrap();
    queue.try_set_size(SIZE).unwrap();
    queue
        .try_set_desc_table_address(GuestAddress(DESC))
        .unwrap();
    queue
        .try_set_avail_ring_address(GuestAddress(AVAIL))
        .unwrap();
    queue.try_set_used_ring_address(GuestAddress(USED)).unwrap();
    queue.set_ready(true);
    queue
}

fn write_desc(memory: &GuestMemoryMmap, index: u16, addr: u64, len: u32, flags: u16, next: u16) {
    memory
        .write_obj(
            Descriptor::new(addr, len, flags, next),
            GuestAddress(DESC + 16 * u64::from(index)),
        )
        .unwrap();
}

fn add_chain(memory: &GuestMemoryMmap, head: u16) {
    let index: u16 = memory.read_obj(GuestAddress(AVAIL + 2)).unwrap();
    memory
        .write_obj(head, GuestAddress(AVAIL + 4 + 2 * u64::from(index % SIZE)))
        .unwrap();
    memory
        .write_obj(index.wrapping_add(1), GuestAddress(AVAIL + 2))
        .unwrap();
}

fn header(memory: &GuestMemoryMmap, request_type: u32, sector: u64) {
    let mut bytes = [0u8; 16];
    bytes[..4].copy_from_slice(&request_type.to_le_bytes());
    bytes[8..].copy_from_slice(&sector.to_le_bytes());
    memory.write_slice(&bytes, GuestAddress(HEADER)).unwrap();
}

fn payload(memory: &GuestMemoryMmap, sector: u64, sectors: u32, flags: u32) {
    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&sector.to_le_bytes());
    bytes[8..12].copy_from_slice(&sectors.to_le_bytes());
    bytes[12..].copy_from_slice(&flags.to_le_bytes());
    memory.write_slice(&bytes, GuestAddress(PAYLOAD)).unwrap();
}

fn in_chain(memory: &GuestMemoryMmap) {
    write_desc(memory, 0, HEADER, 16, NEXT, 1);
    write_desc(memory, 1, DATA, 512, NEXT | WRITE, 2);
    write_desc(memory, 2, STATUS, 1, WRITE, 0);
    add_chain(memory, 0);
}

fn out_chain(memory: &GuestMemoryMmap, data: &[u8]) {
    memory.write_slice(data, GuestAddress(DATA)).unwrap();
    write_desc(memory, 0, HEADER, 16, NEXT, 1);
    write_desc(memory, 1, DATA, data.len() as u32, NEXT, 2);
    write_desc(memory, 2, STATUS, 1, WRITE, 0);
    add_chain(memory, 0);
}

fn flush_chain(memory: &GuestMemoryMmap) {
    write_desc(memory, 0, HEADER, 16, NEXT, 1);
    write_desc(memory, 1, STATUS, 1, WRITE, 0);
    add_chain(memory, 0);
}

fn range_chain(memory: &GuestMemoryMmap) {
    write_desc(memory, 0, HEADER, 16, NEXT, 1);
    write_desc(memory, 1, PAYLOAD, 16, NEXT, 2);
    write_desc(memory, 2, STATUS, 1, WRITE, 0);
    add_chain(memory, 0);
}

fn malformed_header_chain(memory: &GuestMemoryMmap) {
    write_desc(memory, 0, HEADER, 8, NEXT, 1);
    write_desc(memory, 1, STATUS, 1, WRITE, 0);
    add_chain(memory, 0);
}

fn missing_status_chain(memory: &GuestMemoryMmap) {
    write_desc(memory, 0, HEADER, 16, 0, 0);
    add_chain(memory, 0);
}

fn indirect_chain(memory: &GuestMemoryMmap) {
    write_desc(memory, 0, PAYLOAD, 16, INDIRECT, 0);
    add_chain(memory, 0);
}

fn config_bytes(blk: &mut VirtioBlk, offset: u64, len: usize) -> Vec<u8> {
    let mut data = vec![0u8; len];
    blk.read_config(offset, &mut data).unwrap();
    data
}

#[test]
fn spec_and_features_match_the_device() {
    let fixture = Fixture::new(false);
    assert_eq!(fixture.blk.spec().device_id, DEVICE_ID);
    assert_eq!(fixture.blk.spec().name, "block");
    assert_eq!(fixture.blk.spec().queue_max, QUEUE_MAXIMUM);
    assert_eq!(fixture.blk.spec().config_len, CONFIG_LEN);
    assert_eq!(fixture.blk.spec().snapshot, SnapshotSupport::Unsupported);
    assert_eq!(fixture.blk.spec().features, 0x1_2000_6204);

    let read_only = Fixture::new(true);
    assert_eq!(read_only.blk.spec().features, 0x1_2000_0024);
}

#[test]
fn unknown_features_are_rejected() {
    let mut fixture = Fixture::new(false);
    let unsupported = 1u64 << 40;
    assert_eq!(
        fixture
            .blk
            .set_features(fixture.blk.spec().features | unsupported),
        Err(FeatureError { unsupported })
    );
}

#[test]
fn configuration_reports_capacity_and_pads_past_the_end() {
    let mut fixture = Fixture::new(false);
    let bytes = config_bytes(&mut fixture.blk, 0, CONFIG_LEN);
    assert_eq!(
        u64::from_le_bytes(bytes[..8].try_into().unwrap()),
        FILE_SIZE / SECTOR_SIZE
    );
    assert_eq!(u32::from_le_bytes(bytes[12..16].try_into().unwrap()), 254);
    assert_eq!(bytes[56], 1);
    assert!(
        config_bytes(&mut fixture.blk, CONFIG_LEN as u64, 8)
            .iter()
            .all(|byte| *byte == 0)
    );
    assert_eq!(
        fixture.blk.write_config(0, &[1]),
        Err(DeviceError::Unsupported("block configuration write"))
    );
}

#[test]
fn activation_rejects_unready_queues_and_second_activation() {
    let mut fixture = Fixture::new(false);
    let interrupt: Arc<dyn VirtioInterrupt> = Arc::new(TestInterrupt::default());
    let context = || ActivationContext {
        memory: Arc::clone(&fixture.memory),
        queues: vec![ready_queue()],
        interrupt: Arc::clone(&interrupt),
        events: Arc::new(TestRegistrar),
        waker: Arc::new(|| {}),
        sender: EventLoop::new().unwrap().sender(),
    };
    assert_eq!(
        fixture.blk.activate(context()),
        Err(DeviceError::NeedsReset("block device is already active"))
    );

    let mut unready = ready_queue();
    unready.set_ready(false);
    let mut fresh = VirtioBlk::new(BlkBackend::open(&fixture.path, false).unwrap());
    fresh.set_features(fresh.spec().features).unwrap();
    assert_eq!(
        fresh.activate(ActivationContext {
            memory: Arc::clone(&fixture.memory),
            queues: vec![unready],
            interrupt,
            events: Arc::new(TestRegistrar),
            waker: Arc::new(|| {}),
            sender: EventLoop::new().unwrap().sender(),
        }),
        Err(DeviceError::NeedsReset("block queue is not ready"))
    );
}

#[test]
fn reset_clears_the_activation() {
    let mut fixture = Fixture::new(false);
    assert!(fixture.blk.reset().is_ok());
    assert!(fixture.blk.on_event(DeviceEvent::QueueKick(0)).is_err());
    let features = fixture.blk.spec().features;
    fixture.blk.set_features(features).unwrap();
    let interrupt: Arc<dyn VirtioInterrupt> = Arc::new(TestInterrupt::default());
    fixture
        .blk
        .activate(ActivationContext {
            memory: Arc::clone(&fixture.memory),
            queues: vec![ready_queue()],
            interrupt,
            events: Arc::new(TestRegistrar),
            waker: Arc::new(|| {}),
            sender: EventLoop::new().unwrap().sender(),
        })
        .unwrap();
}

#[test]
fn read_request_copies_file_bytes_into_guest_memory() {
    let mut fixture = Fixture::new(false);
    header(&fixture.memory, VIRTIO_BLK_T_IN, 0);
    in_chain(&fixture.memory);
    fixture.kick().unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_OK);
    assert_eq!(fixture.used(), (1, 0, 513));
    assert_eq!(fixture.data(512), vec![0xAA; 512]);
    assert_eq!(fixture.interrupt.raised(), 1);
}

#[test]
fn write_request_updates_the_image() {
    let mut fixture = Fixture::new(false);
    header(&fixture.memory, VIRTIO_BLK_T_OUT, 1);
    out_chain(&fixture.memory, &[0xBB; 512]);
    fixture.kick().unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_OK);
    assert_eq!(fixture.used(), (1, 0, 1));
    assert_eq!(fixture.file_at(512, 512), vec![0xBB; 512]);
}

#[test]
fn flush_request_succeeds() {
    let mut fixture = Fixture::new(false);
    header(&fixture.memory, VIRTIO_BLK_T_FLUSH, 0);
    flush_chain(&fixture.memory);
    fixture.kick().unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_OK);
    assert_eq!(fixture.used(), (1, 0, 1));
}

#[test]
fn discard_request_zeroes_the_range() {
    let mut fixture = Fixture::new(false);
    header(&fixture.memory, VIRTIO_BLK_T_DISCARD, 16);
    payload(&fixture.memory, 16, 16, 0);
    range_chain(&fixture.memory);
    fixture.kick().unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_OK);
    assert_eq!(fixture.file_at(8192, 8192), vec![0u8; 8192]);
}

#[test]
fn write_zeroes_request_zeroes_the_range() {
    let mut fixture = Fixture::new(false);
    header(&fixture.memory, VIRTIO_BLK_T_WRITE_ZEROES, 32);
    payload(&fixture.memory, 32, 16, 0);
    range_chain(&fixture.memory);
    fixture.kick().unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_OK);
    assert_eq!(fixture.file_at(16384, 8192), vec![0u8; 8192]);

    header(&fixture.memory, VIRTIO_BLK_T_WRITE_ZEROES, 48);
    payload(&fixture.memory, 48, 16, VIRTIO_BLK_WRITE_ZEROES_FLAG_UNMAP);
    range_chain(&fixture.memory);
    fixture.kick().unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_OK);
    assert_eq!(fixture.file_at(24576, 8192), vec![0u8; 8192]);
}

#[test]
fn unknown_request_type_is_unsupported() {
    let mut fixture = Fixture::new(false);
    header(&fixture.memory, 99, 0);
    flush_chain(&fixture.memory);
    fixture.kick().unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_UNSUPP);
    assert_eq!(fixture.used(), (1, 0, 1));
}

#[test]
fn unnegotiated_optional_request_is_unsupported() {
    let mut fixture = Fixture::new(false);
    fixture.blk.reset().unwrap();
    let features = fixture.blk.spec().features
        & !(VIRTIO_BLK_F_FLUSH | VIRTIO_BLK_F_DISCARD | VIRTIO_BLK_F_WRITE_ZEROES);
    fixture.blk.set_features(features).unwrap();
    let interrupt: Arc<dyn VirtioInterrupt> = Arc::new(TestInterrupt::default());
    fixture
        .blk
        .activate(ActivationContext {
            memory: Arc::clone(&fixture.memory),
            queues: vec![ready_queue()],
            interrupt,
            events: Arc::new(TestRegistrar),
            waker: Arc::new(|| {}),
            sender: EventLoop::new().unwrap().sender(),
        })
        .unwrap();

    header(&fixture.memory, VIRTIO_BLK_T_FLUSH, 0);
    flush_chain(&fixture.memory);
    fixture.kick().unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_UNSUPP);
}

#[test]
fn short_header_gets_an_io_error() {
    let mut fixture = Fixture::new(false);
    header(&fixture.memory, VIRTIO_BLK_T_IN, 0);
    malformed_header_chain(&fixture.memory);
    fixture.kick().unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_IOERR);
    assert_eq!(fixture.used(), (1, 0, 1));
}

#[test]
fn missing_status_is_a_device_error() {
    let mut fixture = Fixture::new(false);
    header(&fixture.memory, VIRTIO_BLK_T_IN, 0);
    missing_status_chain(&fixture.memory);
    assert!(fixture.kick().is_err());
    assert_eq!(fixture.used().0, 0);
}

#[test]
fn indirect_chain_is_rejected() {
    let mut fixture = Fixture::new(false);
    header(&fixture.memory, VIRTIO_BLK_T_IN, 0);
    indirect_chain(&fixture.memory);
    assert_eq!(
        fixture.kick(),
        Err(DeviceError::NeedsReset("indirect descriptor"))
    );
    assert_eq!(fixture.used().0, 0);
}

#[test]
fn out_of_range_sector_gets_an_io_error() {
    let mut fixture = Fixture::new(false);
    header(&fixture.memory, VIRTIO_BLK_T_IN, u64::MAX / SECTOR_SIZE);
    in_chain(&fixture.memory);
    fixture.kick().unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_IOERR);
    assert_eq!(fixture.used(), (1, 0, 1));
}

#[test]
fn read_only_device_rejects_writes() {
    let mut fixture = Fixture::new(true);
    header(&fixture.memory, VIRTIO_BLK_T_OUT, 1);
    out_chain(&fixture.memory, &[0xBB; 512]);
    fixture.kick().unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_IOERR);

    header(&fixture.memory, VIRTIO_BLK_T_DISCARD, 2);
    payload(&fixture.memory, 2, 1, 0);
    range_chain(&fixture.memory);
    fixture.kick().unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_UNSUPP);
}

#[test]
fn empty_kick_does_not_interrupt() {
    let mut fixture = Fixture::new(false);
    fixture.kick().unwrap();
    assert_eq!(fixture.interrupt.raised(), 0);
    assert_eq!(fixture.used().0, 0);
}

#[test]
fn config_and_features_are_available_before_activation() {
    let fixture = Fixture::new(false);
    assert!(fixture.blk.spec().features & VIRTIO_F_VERSION_1 != 0);
    assert!(fixture.blk.spec().features & VIRTIO_BLK_F_RO == 0);
}

#[test]
fn discard_out_of_range_is_an_io_error() {
    let mut fixture = Fixture::new(false);
    header(
        &fixture.memory,
        VIRTIO_BLK_T_DISCARD,
        FILE_SIZE / SECTOR_SIZE,
    );
    payload(&fixture.memory, FILE_SIZE / SECTOR_SIZE, 1, 0);
    range_chain(&fixture.memory);
    fixture.kick().unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_IOERR);
}

#[test]
fn write_zeroes_out_of_range_is_an_io_error() {
    let mut fixture = Fixture::new(false);
    header(
        &fixture.memory,
        VIRTIO_BLK_T_WRITE_ZEROES,
        FILE_SIZE / SECTOR_SIZE,
    );
    payload(&fixture.memory, FILE_SIZE / SECTOR_SIZE, 1, 0);
    range_chain(&fixture.memory);
    fixture.kick().unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_IOERR);
}

#[test]
fn zero_sector_payload_is_an_io_error() {
    let mut fixture = Fixture::new(false);
    header(&fixture.memory, VIRTIO_BLK_T_DISCARD, 2);
    payload(&fixture.memory, 2, 0, 0);
    range_chain(&fixture.memory);
    fixture.kick().unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_IOERR);
}

#[test]
fn writable_header_is_an_io_error() {
    let mut fixture = Fixture::new(false);
    header(&fixture.memory, VIRTIO_BLK_T_IN, 0);
    write_desc(&fixture.memory, 0, HEADER, 16, NEXT | WRITE, 1);
    write_desc(&fixture.memory, 1, DATA, 512, NEXT | WRITE, 2);
    write_desc(&fixture.memory, 2, STATUS, 1, WRITE, 0);
    add_chain(&fixture.memory, 0);
    fixture.kick().unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_IOERR);
}

#[test]
fn unnegotiated_flush_still_syncs_writes() {
    let mut fixture = Fixture::new(false);
    fixture.blk.reset().unwrap();
    let features = fixture.blk.spec().features & !VIRTIO_BLK_F_FLUSH;
    fixture.blk.set_features(features).unwrap();
    let interrupt: Arc<dyn VirtioInterrupt> = Arc::new(TestInterrupt::default());
    fixture
        .blk
        .activate(ActivationContext {
            memory: Arc::clone(&fixture.memory),
            queues: vec![ready_queue()],
            interrupt,
            events: Arc::new(TestRegistrar),
            waker: Arc::new(|| {}),
            sender: EventLoop::new().unwrap().sender(),
        })
        .unwrap();

    header(&fixture.memory, VIRTIO_BLK_T_OUT, 1);
    out_chain(&fixture.memory, &[0xCC; 512]);
    fixture.kick().unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_OK);
    assert_eq!(fixture.used(), (1, 0, 1));
}

#[test]
fn discard_flags_are_unsupported() {
    let mut fixture = Fixture::new(false);
    header(&fixture.memory, VIRTIO_BLK_T_DISCARD, 16);
    payload(&fixture.memory, 16, 16, 1);
    range_chain(&fixture.memory);
    fixture.kick().unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_UNSUPP);
}

#[test]
fn write_zeroes_unknown_flag_is_unsupported() {
    let mut fixture = Fixture::new(false);
    header(&fixture.memory, VIRTIO_BLK_T_WRITE_ZEROES, 32);
    payload(&fixture.memory, 32, 16, 2);
    range_chain(&fixture.memory);
    fixture.kick().unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_UNSUPP);
}

#[test]
fn misaligned_read_length_is_an_io_error() {
    let mut fixture = Fixture::new(false);
    header(&fixture.memory, VIRTIO_BLK_T_IN, 0);
    write_desc(&fixture.memory, 0, HEADER, 16, NEXT, 1);
    write_desc(&fixture.memory, 1, DATA, 511, NEXT | WRITE, 2);
    write_desc(&fixture.memory, 2, STATUS, 1, WRITE, 0);
    add_chain(&fixture.memory, 0);
    fixture.kick().unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_IOERR);
    assert_eq!(fixture.used(), (1, 0, 1));
}
