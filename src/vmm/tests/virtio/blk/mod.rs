// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! virtio-blk tests: the device contract, request parsing and completion
//! through the `VirtQueues` facade over a driver-side `MockSplitQueue`, the
//! imago backend on raw and qcow2 images, and the deferred path through a
//! fake backend that keeps every request.

use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU8, AtomicUsize, Ordering},
    },
};

use imago::{
    FormatCreateBuilder, Storage, StorageCreateOptions, file::File as ImagoFile, qcow2::Qcow2,
};
use mio::{Interest, Registry, Token, event::Source};
use tempfile::{TempDir, tempdir};
use virtio_queue::{
    Queue, QueueT, desc::RawDescriptor, desc::split::Descriptor, mock::MockSplitQueue,
};
use vm_memory::{Bytes, GuestAddress};

use super::{
    DEVICE_ID, QUEUE_MAX, QUEUE_MAXIMUM, SECTOR_SIZE, VIRTIO_BLK_F_DISCARD, VIRTIO_BLK_F_FLUSH,
    VIRTIO_BLK_F_RO, VIRTIO_BLK_F_SEG_MAX, VIRTIO_BLK_S_IOERR, VIRTIO_BLK_S_OK,
    VIRTIO_BLK_S_UNSUPP, VIRTIO_BLK_T_DISCARD, VIRTIO_BLK_T_FLUSH, VIRTIO_BLK_T_IN,
    VIRTIO_BLK_T_OUT,
    backend::{CompletedRequest, DiskBackend, DiskInfo, Request, RequestKind, SubmitOutcome},
    device::VirtioBlk,
    imago::ImagoBackend,
};
use crate::{
    config::DiskFormat,
    events::EventLoop,
    memory::GuestMemoryMmap,
    virtio::{
        ActivationContext, DeviceError, DeviceEvent, EventError, EventRegistrar, EventSource,
        FeatureError, SnapshotSupport, SourceId, VirtioDevice, VirtioInterrupt,
        mmio::VIRTIO_F_VERSION_1,
        queue::{VIRTIO_F_EVENT_IDX, VIRTIO_F_INDIRECT_DESC, VirtQueues},
    },
};

/// `VIRTIO_BLK_F_WRITE_ZEROES`, which the device does not offer.
const VIRTIO_BLK_F_WRITE_ZEROES: u64 = 1 << 14;
/// Guest memory: the mock queue at 0, the used ring at `USED_RING`, request
/// buffers from 1 MiB up.
const MEMORY_BYTES: usize = 2 << 20;
/// The used ring, placed by the test: the mock lays its own used ring inside
/// the available ring (its `end` counts entries, not bytes), so the device
/// gets this address instead and the mock only drives the available side.
const USED_RING: u64 = 0x2000;
const HEADER: u64 = 0x10_0000;
const DATA: u64 = 0x10_1000;
const STATUS: u64 = 0x10_4000;
const PAYLOAD: u64 = 0x10_4800;
const DATA2: u64 = 0x10_5000;
const STATUS2: u64 = 0x10_6000;
const NEXT: u16 = 1;
const WRITE: u16 = 2;
const IMAGE_BYTES: u64 = 1 << 20;
const CONFIG_LEN: usize = 60;
/// A chain's descriptors: address, length and flags.
type Chain<'a> = &'a [(u64, u32, u16)];

/// A raw image: 1 MiB with a 16-sector pattern at sectors 0, 16, 32 and 48.
fn raw_image(dir: &Path) -> PathBuf {
    let path = dir.join("disk.raw");
    let mut file = File::create(&path).unwrap();
    file.set_len(IMAGE_BYTES).unwrap();
    for (sector, byte) in [(0u64, 0xAAu8), (16, 0xCC), (32, 0xDD), (48, 0xEE)] {
        file.seek(SeekFrom::Start(sector * SECTOR_SIZE)).unwrap();
        file.write_all(&[byte; 16 * 512]).unwrap();
    }
    path
}

/// A qcow2 image over `backing`, a raw file in the same directory.
fn qcow2_image(dir: &Path, backing: &Path) -> PathBuf {
    let path = dir.join("disk.qcow2");
    let file = ImagoFile::create_open(StorageCreateOptions::new().filename(&path).size(0)).unwrap();
    Qcow2::<ImagoFile>::create_builder(file)
        .size(IMAGE_BYTES)
        .backing(
            backing.file_name().unwrap().to_str().unwrap().to_owned(),
            "raw".to_owned(),
        )
        .create()
        .unwrap();
    path
}

fn file_at(path: &Path, offset: u64, len: usize) -> Vec<u8> {
    let mut file = File::open(path).unwrap();
    file.seek(SeekFrom::Start(offset)).unwrap();
    let mut data = vec![0u8; len];
    file.read_exact(&mut data).unwrap();
    data
}

#[derive(Default)]
struct TestInterrupt {
    raised: AtomicUsize,
    status: AtomicU8,
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

    fn set_needs_reset(&self) {}
}

/// Hands out ids and counts registrations and deregistrations.
#[derive(Default)]
struct TestRegistrar {
    registered: AtomicUsize,
    deregistered: Mutex<Vec<SourceId>>,
}

impl EventRegistrar for TestRegistrar {
    fn register(&self, mut source: Box<dyn EventSource>) -> Result<SourceId, EventError> {
        let _ = source.as_source();
        let id = self.registered.fetch_add(1, Ordering::SeqCst);
        Ok(SourceId(id as u32))
    }

    fn deregister(&self, id: SourceId) {
        self.deregistered.lock().unwrap().push(id);
    }
}

/// A source that registers nothing; the test delivers readiness itself.
struct TestSource;

impl EventSource for TestSource {
    fn as_source(&mut self) -> &mut dyn Source {
        self
    }
}

impl Source for TestSource {
    fn register(&mut self, _: &Registry, _: Token, _: Interest) -> io::Result<()> {
        Ok(())
    }

    fn reregister(&mut self, _: &Registry, _: Token, _: Interest) -> io::Result<()> {
        Ok(())
    }

    fn deregister(&mut self, _: &Registry) -> io::Result<()> {
        Ok(())
    }
}

/// What the fake backend saw and holds; the test completes requests by hand.
#[derive(Default)]
struct FakeState {
    pending: Vec<(u32, Request)>,
    done: Vec<CompletedRequest>,
    flushes: usize,
}

impl FakeState {
    /// Finishes the pending request submitted under `token` with `status`,
    /// filling a read with `fill`.
    fn complete(&mut self, token: u32, status: u8, fill: u8) {
        let index = self
            .pending
            .iter()
            .position(|(candidate, _)| *candidate == token)
            .expect("the token is pending");
        let (token, mut request) = self.pending.remove(index);
        if let RequestKind::In { buf, .. } = &mut request.kind {
            buf.fill(fill);
        }
        self.done.push(CompletedRequest {
            token,
            status,
            request,
        });
    }
}

/// A backend that keeps every request until the test completes it.
struct FakeBackend {
    disk_info: DiskInfo,
    state: Arc<Mutex<FakeState>>,
}

impl DiskBackend for FakeBackend {
    fn disk_info(&self) -> DiskInfo {
        self.disk_info
    }

    fn submit(&mut self, token: u32, request: Request) -> SubmitOutcome {
        self.state.lock().unwrap().pending.push((token, request));
        SubmitOutcome::Pending
    }

    fn completions(&mut self, out: &mut Vec<CompletedRequest>) {
        out.append(&mut self.state.lock().unwrap().done);
    }

    fn event_source(&mut self) -> Option<Box<dyn EventSource>> {
        Some(Box::new(TestSource))
    }

    fn flush(&mut self) -> io::Result<()> {
        self.state.lock().unwrap().flushes += 1;
        Ok(())
    }
}

/// An activated device over 2 MiB of guest memory with the mock queue at 0.
/// The memory is leaked so the mock, which borrows it, can live in the
/// fixture; constructing a mock zeroes the ring indexes, so there is one.
struct Fixture {
    _dir: TempDir,
    path: PathBuf,
    blk: VirtioBlk,
    memory: Arc<GuestMemoryMmap>,
    /// The leaked memory the mock borrows.
    guest: &'static GuestMemoryMmap,
    mock: MockSplitQueue<'static, GuestMemoryMmap>,
    interrupt: Arc<TestInterrupt>,
    registrar: Arc<TestRegistrar>,
    fake: Option<Arc<Mutex<FakeState>>>,
}

impl Fixture {
    /// A device over a raw image, with every offered feature negotiated.
    fn raw(read_only: bool) -> Self {
        let dir = tempdir().unwrap();
        let path = raw_image(dir.path());
        let backend = ImagoBackend::open(&path, DiskFormat::Raw, read_only).unwrap();
        Self::new(dir, path, Box::new(backend), None)
    }

    /// A device over a qcow2 image whose backing file is the raw image.
    fn qcow2() -> Self {
        let dir = tempdir().unwrap();
        let backing = raw_image(dir.path());
        let path = qcow2_image(dir.path(), &backing);
        let backend = ImagoBackend::open(&path, DiskFormat::Qcow2, false).unwrap();
        Self::new(dir, path, Box::new(backend), None)
    }

    /// A device over the fake backend, which never completes inline.
    fn pending() -> Self {
        let dir = tempdir().unwrap();
        let path = dir.path().join("none");
        let state = Arc::new(Mutex::new(FakeState::default()));
        let backend = FakeBackend {
            disk_info: DiskInfo {
                capacity_sectors: IMAGE_BYTES / SECTOR_SIZE,
                read_only: false,
                discard_sector_alignment: 1,
            },
            state: Arc::clone(&state),
        };
        Self::new(dir, path, Box::new(backend), Some(state))
    }

    fn new(
        dir: TempDir,
        path: PathBuf,
        backend: Box<dyn DiskBackend>,
        fake: Option<Arc<Mutex<FakeState>>>,
    ) -> Self {
        let mut blk = VirtioBlk::new(backend);
        let features = blk.spec().features;
        blk.set_features(features).unwrap();
        let leaked: &'static GuestMemoryMmap = Box::leak(Box::new(
            GuestMemoryMmap::from_ranges(&[(GuestAddress(0), MEMORY_BYTES)]).unwrap(),
        ));
        let mut fixture = Self {
            _dir: dir,
            path,
            blk,
            memory: Arc::new(leaked.clone()),
            guest: leaked,
            mock: MockSplitQueue::new(leaked, QUEUE_MAX),
            interrupt: Arc::new(TestInterrupt::default()),
            registrar: Arc::new(TestRegistrar::default()),
            fake,
        };
        fixture.activate().unwrap();
        fixture
    }

    /// A ready queue over the mock's descriptor table and available ring and
    /// the test's used ring, as the transport builds it.
    fn queue(&self) -> Queue {
        let mut queue = Queue::new(QUEUE_MAX).unwrap();
        queue.try_set_size(QUEUE_MAX).unwrap();
        queue
            .try_set_desc_table_address(self.mock.desc_table_addr())
            .unwrap();
        queue
            .try_set_avail_ring_address(self.mock.avail_addr())
            .unwrap();
        queue
            .try_set_used_ring_address(GuestAddress(USED_RING))
            .unwrap();
        queue.set_ready(true);
        queue
    }

    /// The activation context for the mock queue, as the transport builds it:
    /// indirect descriptors and `EVENT_IDX` not negotiated.
    fn context(&self, queue: Queue) -> ActivationContext {
        let queues = VirtQueues::prepare(
            vec![queue],
            QUEUE_MAXIMUM,
            false,
            false,
            Arc::clone(&self.memory),
        )
        .unwrap();
        ActivationContext {
            memory: Arc::clone(&self.memory),
            queues,
            interrupt: Arc::clone(&self.interrupt) as Arc<dyn VirtioInterrupt>,
            events: Arc::clone(&self.registrar) as Arc<dyn EventRegistrar>,
            waker: Arc::new(|| {}),
            sender: EventLoop::new().unwrap().sender(),
        }
    }

    fn activate(&mut self) -> Result<(), DeviceError> {
        let ctx = self.context(self.queue());
        self.blk.activate(ctx)
    }

    /// Resets the device and activates it again with `features`, over fresh
    /// rings, as a driver that re-initializes the device provides.
    fn reactivate(&mut self, features: u64) {
        self.blk.reset().unwrap();
        self.fresh_rings();
        self.blk.set_features(features).unwrap();
        self.activate().unwrap();
    }

    /// Zeroes the ring indexes, as a driver does before it activates the
    /// device again; the descriptor table and the request buffers stay.
    fn fresh_rings(&mut self) {
        self.mock = MockSplitQueue::new(self.guest, QUEUE_MAX);
        self.memory
            .write_obj(0u16, GuestAddress(USED_RING + 2))
            .unwrap();
    }

    /// Makes `descriptors` available as one chain at the table start.
    fn chain(&self, descriptors: Chain<'_>) {
        let raw: Vec<RawDescriptor> = descriptors
            .iter()
            .map(|&(addr, len, flags)| RawDescriptor::from(Descriptor::new(addr, len, flags, 0)))
            .collect();
        self.mock.build_desc_chain(&raw).unwrap();
    }

    /// Makes `descriptors` available as one chain at table index `offset`,
    /// so that several chains can be outstanding at once.
    fn chain_at(&self, offset: u16, descriptors: Chain<'_>) {
        let last = descriptors.len() - 1;
        let raw: Vec<RawDescriptor> = descriptors
            .iter()
            .enumerate()
            .map(|(index, &(addr, len, flags))| {
                let (flags, next) = if index == last {
                    (flags, 0)
                } else {
                    (flags | NEXT, offset + index as u16 + 1)
                };
                RawDescriptor::from(Descriptor::new(addr, len, flags, next))
            })
            .collect();
        self.mock.add_desc_chains(&raw, offset).unwrap();
    }

    fn header(&self, request_type: u32, sector: u64) {
        let mut bytes = [0u8; 16];
        bytes[..4].copy_from_slice(&request_type.to_le_bytes());
        bytes[8..].copy_from_slice(&sector.to_le_bytes());
        self.memory
            .write_slice(&bytes, GuestAddress(HEADER))
            .unwrap();
    }

    fn payload(&self, sector: u64, sectors: u32, flags: u32) {
        let mut bytes = [0u8; 16];
        bytes[..8].copy_from_slice(&sector.to_le_bytes());
        bytes[8..12].copy_from_slice(&sectors.to_le_bytes());
        bytes[12..].copy_from_slice(&flags.to_le_bytes());
        self.memory
            .write_slice(&bytes, GuestAddress(PAYLOAD))
            .unwrap();
    }

    fn kick(&mut self) -> Result<(), DeviceError> {
        self.blk.on_event(DeviceEvent::QueueKick(0))
    }

    /// Submits a read of `len` bytes at `sector` into `DATA`.
    fn read(&mut self, sector: u64, len: u32) -> Result<(), DeviceError> {
        self.header(VIRTIO_BLK_T_IN, sector);
        self.chain(&[(HEADER, 16, 0), (DATA, len, WRITE), (STATUS, 1, WRITE)]);
        self.kick()
    }

    /// Submits a write of `data` at `sector` from `DATA`.
    fn write(&mut self, sector: u64, data: &[u8]) -> Result<(), DeviceError> {
        self.memory.write_slice(data, GuestAddress(DATA)).unwrap();
        self.header(VIRTIO_BLK_T_OUT, sector);
        self.chain(&[
            (HEADER, 16, 0),
            (DATA, data.len() as u32, 0),
            (STATUS, 1, WRITE),
        ]);
        self.kick()
    }

    /// Submits a request without data: `FLUSH`, or an unknown type.
    fn bare(&mut self, request_type: u32) -> Result<(), DeviceError> {
        self.header(request_type, 0);
        self.chain(&[(HEADER, 16, 0), (STATUS, 1, WRITE)]);
        self.kick()
    }

    /// Submits a discard of `sectors` sectors at `sector` with `flags`.
    fn discard(&mut self, sector: u64, sectors: u32, flags: u32) -> Result<(), DeviceError> {
        self.header(VIRTIO_BLK_T_DISCARD, sector);
        self.payload(sector, sectors, flags);
        self.chain(&[(HEADER, 16, 0), (PAYLOAD, 16, 0), (STATUS, 1, WRITE)]);
        self.kick()
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

    /// The used ring: its index and every entry as `(id, len)`.
    fn used(&self) -> (u16, Vec<(u32, u32)>) {
        let index: u16 = self.memory.read_obj(GuestAddress(USED_RING + 2)).unwrap();
        let entries = (0..u64::from(index))
            .map(|i| {
                let entry = GuestAddress(USED_RING + 4 + 8 * i);
                (
                    self.memory.read_obj(entry).unwrap(),
                    self.memory.read_obj(GuestAddress(entry.0 + 4)).unwrap(),
                )
            })
            .collect();
        (index, entries)
    }

    fn raised(&self) -> usize {
        self.interrupt.raised.load(Ordering::SeqCst)
    }

    fn fake(&self) -> std::sync::MutexGuard<'_, FakeState> {
        self.fake
            .as_ref()
            .expect("the fake backend")
            .lock()
            .unwrap()
    }

    fn config_bytes(&mut self, offset: u64, len: usize) -> Vec<u8> {
        let mut data = vec![0u8; len];
        self.blk.read_config(offset, &mut data).unwrap();
        data
    }
}

#[test]
fn the_spec_offers_the_features_of_a_writable_or_read_only_disk() {
    let fixture = Fixture::raw(false);
    let spec = fixture.blk.spec();
    assert_eq!(spec.device_id, DEVICE_ID);
    assert_eq!(spec.name, "block");
    assert_eq!(spec.queue_max, QUEUE_MAXIMUM);
    assert_eq!(spec.config_len, CONFIG_LEN);
    assert_eq!(spec.snapshot, SnapshotSupport::Unsupported);
    assert_eq!(
        spec.features,
        VIRTIO_F_VERSION_1
            | VIRTIO_F_INDIRECT_DESC
            | VIRTIO_BLK_F_SEG_MAX
            | VIRTIO_BLK_F_FLUSH
            | VIRTIO_BLK_F_DISCARD
    );
    assert_eq!(
        Fixture::raw(true).blk.spec().features,
        VIRTIO_F_VERSION_1 | VIRTIO_F_INDIRECT_DESC | VIRTIO_BLK_F_SEG_MAX | VIRTIO_BLK_F_RO
    );
}

#[test]
fn unoffered_features_are_rejected() {
    let mut fixture = Fixture::raw(false);
    let offered = fixture.blk.spec().features;
    for unsupported in [1u64 << 40, VIRTIO_BLK_F_WRITE_ZEROES, VIRTIO_F_EVENT_IDX] {
        assert_eq!(
            fixture.blk.set_features(offered | unsupported),
            Err(FeatureError { unsupported })
        );
    }
}

#[test]
fn configuration_reports_the_disk_info_and_pads_past_the_end() {
    let mut fixture = Fixture::raw(false);
    let bytes = fixture.config_bytes(0, CONFIG_LEN);
    assert_eq!(
        u64::from_le_bytes(bytes[..8].try_into().unwrap()),
        IMAGE_BYTES / SECTOR_SIZE
    );
    assert_eq!(u32::from_le_bytes(bytes[12..16].try_into().unwrap()), 254);
    assert_eq!(
        u32::from_le_bytes(bytes[36..40].try_into().unwrap()),
        u32::MAX
    );
    assert_eq!(u32::from_le_bytes(bytes[40..44].try_into().unwrap()), 1);
    assert_eq!(u32::from_le_bytes(bytes[44..48].try_into().unwrap()), 1);
    assert!(bytes[48..].iter().all(|byte| *byte == 0));
    assert!(
        fixture.config_bytes(CONFIG_LEN as u64 - 4, 8)[4..]
            .iter()
            .all(|byte| *byte == 0)
    );
    assert_eq!(
        fixture.blk.write_config(0, &[1]),
        Err(DeviceError::Unsupported("block configuration write"))
    );
}

#[test]
fn activation_needs_a_ready_queue_and_happens_once_per_reset() {
    let mut fixture = Fixture::raw(false);
    assert_eq!(
        fixture.activate(),
        Err(DeviceError::NeedsReset("block device is already active"))
    );
    assert!(fixture.blk.reset().is_ok());
    fixture.fresh_rings();
    assert_eq!(
        fixture.kick(),
        Err(DeviceError::NeedsReset("block device is not active"))
    );
    let mut unready = fixture.queue();
    unready.set_ready(false);
    let ctx = fixture.context(unready);
    assert_eq!(
        fixture.blk.activate(ctx),
        Err(DeviceError::NeedsReset("block queue is not ready"))
    );
    assert!(fixture.activate().is_ok());
    fixture.read(0, 512).unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_OK);
}

#[test]
fn a_read_copies_the_image_into_the_guest_and_interrupts_once() {
    let mut fixture = Fixture::raw(false);
    fixture.read(0, 512).unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_OK);
    assert_eq!(fixture.used(), (1, vec![(0, 513)]));
    assert_eq!(fixture.data(512), vec![0xAA; 512]);
    assert_eq!(fixture.raised(), 1);
}

#[test]
fn a_write_reaches_the_image() {
    let mut fixture = Fixture::raw(false);
    fixture.write(1, &[0xBB; 512]).unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_OK);
    assert_eq!(fixture.used(), (1, vec![(0, 1)]));
    assert_eq!(file_at(&fixture.path, 512, 512), vec![0xBB; 512]);
}

#[test]
fn misaligned_and_out_of_range_transfers_are_io_errors() {
    let mut fixture = Fixture::raw(false);
    fixture.read(0, 511).unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_IOERR);
    fixture.read(IMAGE_BYTES / SECTOR_SIZE, 512).unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_IOERR);
    fixture.read(u64::MAX / SECTOR_SIZE, 512).unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_IOERR);
    assert_eq!(fixture.used(), (3, vec![(0, 1), (0, 1), (0, 1)]));
}

#[test]
fn malformed_chains_never_reach_the_backend() {
    let mut fixture = Fixture::pending();
    // A writable header.
    fixture.header(VIRTIO_BLK_T_IN, 0);
    fixture.chain(&[(HEADER, 16, WRITE), (DATA, 512, WRITE), (STATUS, 1, WRITE)]);
    fixture.kick().unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_IOERR);
    // A readable descriptor after a writable one.
    fixture.chain(&[
        (HEADER, 16, 0),
        (DATA, 512, WRITE),
        (PAYLOAD, 16, 0),
        (STATUS, 1, WRITE),
    ]);
    fixture.kick().unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_IOERR);
    // A short header.
    fixture.chain(&[(HEADER, 8, 0), (STATUS, 1, WRITE)]);
    fixture.kick().unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_IOERR);
    // A transfer over the bounce buffer limit.
    fixture.chain(&[
        (HEADER, 16, 0),
        (DATA, 4 * 1024 * 1024 + 512, WRITE),
        (STATUS, 1, WRITE),
    ]);
    fixture.kick().unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_IOERR);
    // Data where the type takes none.
    fixture.header(VIRTIO_BLK_T_FLUSH, 0);
    fixture.chain(&[(HEADER, 16, 0), (DATA, 512, WRITE), (STATUS, 1, WRITE)]);
    fixture.kick().unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_IOERR);
    assert_eq!(fixture.used().0, 5);
    assert!(
        fixture.fake().pending.is_empty(),
        "the backend saw a request"
    );
}

#[test]
fn a_chain_without_a_status_byte_needs_a_reset() {
    let mut fixture = Fixture::pending();
    fixture.header(VIRTIO_BLK_T_IN, 0);
    fixture.chain(&[(HEADER, 16, 0)]);
    assert_eq!(fixture.kick(), Err(DeviceError::NeedsReset("block status")));
    assert_eq!(fixture.used().0, 0);
    assert!(fixture.fake().pending.is_empty());
}

#[test]
fn an_indirect_chain_is_rejected_when_not_negotiated() {
    let mut fixture = Fixture::raw(false);
    fixture.header(VIRTIO_BLK_T_IN, 0);
    fixture.chain(&[(PAYLOAD, 16, 4)]);
    assert_eq!(
        fixture.kick(),
        Err(DeviceError::NeedsReset("indirect descriptor"))
    );
    assert_eq!(fixture.used().0, 0);
}

#[test]
fn flush_is_served_when_negotiated_and_unsupported_otherwise() {
    let mut fixture = Fixture::raw(false);
    fixture.bare(VIRTIO_BLK_T_FLUSH).unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_OK);
    assert_eq!(fixture.used(), (1, vec![(0, 1)]));

    let features = fixture.blk.spec().features & !VIRTIO_BLK_F_FLUSH;
    fixture.reactivate(features);
    fixture.bare(VIRTIO_BLK_T_FLUSH).unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_UNSUPP);
}

#[test]
fn a_write_syncs_itself_when_flush_is_not_negotiated() {
    let mut fixture = Fixture::pending();
    fixture.write(1, &[0xBB; 512]).unwrap();
    assert!(matches!(
        fixture.fake().pending[0].1.kind,
        RequestKind::Out { sync: false, .. }
    ));
    let token = fixture.fake().pending[0].0;
    fixture.fake().complete(token, VIRTIO_BLK_S_OK, 0);
    fixture
        .blk
        .on_event(DeviceEvent::BackendReady(SourceId(0)))
        .unwrap();
    let features = fixture.blk.spec().features & !VIRTIO_BLK_F_FLUSH;
    fixture.reactivate(features);
    fixture.write(1, &[0xBB; 512]).unwrap();
    assert!(matches!(
        fixture.fake().pending[0].1.kind,
        RequestKind::Out { sync: true, .. }
    ));
}

#[test]
fn unknown_request_types_are_unsupported() {
    let mut fixture = Fixture::raw(false);
    fixture.bare(13).unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_UNSUPP);
    assert_eq!(fixture.used(), (1, vec![(0, 1)]));
}

#[test]
fn discard_zeroes_the_range_and_checks_its_bounds() {
    let mut fixture = Fixture::raw(false);
    fixture.discard(16, 16, 0).unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_OK);
    assert_eq!(file_at(&fixture.path, 8192, 8192), vec![0u8; 8192]);
    fixture.read(16, 512).unwrap();
    assert_eq!(fixture.data(512), vec![0u8; 512]);

    fixture.discard(IMAGE_BYTES / SECTOR_SIZE, 1, 0).unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_IOERR);
    fixture.discard(2, 0, 0).unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_IOERR);
    fixture.discard(2, 1, 1).unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_UNSUPP);
}

#[test]
fn a_read_only_disk_refuses_writes_and_offers_no_discard() {
    let mut fixture = Fixture::raw(true);
    fixture.write(1, &[0xBB; 512]).unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_IOERR);
    assert_eq!(
        file_at(&fixture.path, 512, 512),
        vec![0xAA; 512],
        "the image changed"
    );
    fixture.discard(2, 1, 0).unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_UNSUPP);
    fixture.read(0, 512).unwrap();
    assert_eq!(fixture.data(512), vec![0xAA; 512]);
}

#[test]
fn a_qcow2_image_reads_through_to_its_backing_file_and_keeps_writes_to_itself() {
    let mut fixture = Fixture::qcow2();
    let backing = fixture.path.with_file_name("disk.raw");
    let before = std::fs::read(&backing).unwrap();
    let size_before = std::fs::metadata(&fixture.path).unwrap().len();

    fixture.read(16, 512).unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_OK);
    assert_eq!(fixture.data(512), vec![0xCC; 512]);

    fixture.write(16, &[0x11; 512]).unwrap();
    assert_eq!(fixture.status(), VIRTIO_BLK_S_OK);
    fixture.read(16, 512).unwrap();
    assert_eq!(fixture.data(512), vec![0x11; 512]);
    fixture.read(17, 512).unwrap();
    assert_eq!(
        fixture.data(512),
        vec![0xCC; 512],
        "the rest of the cluster comes from the backing file"
    );

    fixture.bare(VIRTIO_BLK_T_FLUSH).unwrap();
    assert_eq!(
        std::fs::read(&backing).unwrap(),
        before,
        "the backing file changed"
    );
    assert!(
        std::fs::metadata(&fixture.path).unwrap().len() > size_before,
        "the qcow2 did not grow"
    );
}

#[test]
fn an_empty_kick_does_not_interrupt() {
    let mut fixture = Fixture::raw(false);
    fixture.kick().unwrap();
    assert_eq!(fixture.raised(), 0);
    assert_eq!(fixture.used().0, 0);
}

#[test]
fn a_pending_request_completes_when_the_backend_signals() {
    let mut fixture = Fixture::pending();
    assert_eq!(fixture.registrar.registered.load(Ordering::SeqCst), 1);
    fixture.read(0, 512).unwrap();
    assert_eq!(fixture.used().0, 0, "a pending chain has no used entry");
    assert_eq!(fixture.raised(), 0);
    let token = fixture.fake().pending[0].0;

    fixture
        .blk
        .on_event(DeviceEvent::BackendReady(SourceId(7)))
        .unwrap();
    assert_eq!(fixture.used().0, 0, "an unknown source changes nothing");

    fixture.fake().complete(token, VIRTIO_BLK_S_OK, 0xAB);
    fixture
        .blk
        .on_event(DeviceEvent::BackendReady(SourceId(0)))
        .unwrap();
    assert_eq!(fixture.used(), (1, vec![(0, 513)]));
    assert_eq!(fixture.status(), VIRTIO_BLK_S_OK);
    assert_eq!(fixture.data(512), vec![0xAB; 512]);
    assert_eq!(fixture.raised(), 1);
}

#[test]
fn pending_requests_complete_in_any_order() {
    let mut fixture = Fixture::pending();
    fixture.header(VIRTIO_BLK_T_IN, 0);
    fixture.chain_at(
        0,
        &[(HEADER, 16, 0), (DATA, 512, WRITE), (STATUS, 1, WRITE)],
    );
    fixture.chain_at(
        3,
        &[(HEADER, 16, 0), (DATA2, 1024, WRITE), (STATUS2, 1, WRITE)],
    );
    fixture.kick().unwrap();
    let (first, second) = {
        let fake = fixture.fake();
        (fake.pending[0].0, fake.pending[1].0)
    };
    assert_ne!(first, second);

    fixture.fake().complete(second, VIRTIO_BLK_S_OK, 0x22);
    fixture
        .blk
        .on_event(DeviceEvent::BackendReady(SourceId(0)))
        .unwrap();
    assert_eq!(fixture.used(), (1, vec![(3, 1025)]));
    let status2: u8 = fixture.memory.read_obj(GuestAddress(STATUS2)).unwrap();
    assert_eq!(status2, VIRTIO_BLK_S_OK);

    fixture.fake().complete(first, VIRTIO_BLK_S_IOERR, 0x11);
    fixture
        .blk
        .on_event(DeviceEvent::BackendReady(SourceId(0)))
        .unwrap();
    assert_eq!(fixture.used(), (2, vec![(3, 1025), (0, 1)]));
    assert_eq!(fixture.status(), VIRTIO_BLK_S_IOERR);
    assert_eq!(
        fixture.data(512),
        vec![0u8; 512],
        "a failed read writes no data"
    );
    assert_eq!(fixture.raised(), 2);
}

#[test]
fn reset_fails_the_device_while_a_request_is_in_flight() {
    let mut fixture = Fixture::pending();
    fixture.read(0, 512).unwrap();
    assert_eq!(
        fixture.blk.reset(),
        Err(DeviceError::Fatal("block requests in flight at reset"))
    );
    assert_eq!(fixture.fake().flushes, 0);
    assert_eq!(
        *fixture.registrar.deregistered.lock().unwrap(),
        vec![SourceId(0)]
    );
}

#[test]
fn reset_with_nothing_in_flight_flushes_and_a_rebind_registers_a_fresh_source() {
    let mut fixture = Fixture::pending();
    assert_eq!(fixture.blk.reset(), Ok(()));
    assert_eq!(fixture.fake().flushes, 1);
    assert_eq!(
        *fixture.registrar.deregistered.lock().unwrap(),
        vec![SourceId(0)]
    );

    fixture.fresh_rings();
    let features = fixture.blk.spec().features;
    fixture.blk.set_features(features).unwrap();
    assert!(fixture.activate().is_ok());
    assert_eq!(fixture.registrar.registered.load(Ordering::SeqCst), 2);
    fixture.read(0, 512).unwrap();
    let token = fixture.fake().pending[0].0;
    fixture.fake().complete(token, VIRTIO_BLK_S_OK, 0xCD);
    fixture
        .blk
        .on_event(DeviceEvent::BackendReady(SourceId(0)))
        .unwrap();
    assert_eq!(fixture.used().0, 0, "the old generation's id is stale");
    fixture
        .blk
        .on_event(DeviceEvent::BackendReady(SourceId(1)))
        .unwrap();
    assert_eq!(fixture.used(), (1, vec![(0, 513)]));
    assert_eq!(fixture.data(512), vec![0xCD; 512]);
}

#[test]
fn quiesce_flushes_the_backend() {
    let mut fixture = Fixture::pending();
    assert_eq!(fixture.blk.quiesce(), Ok(()));
    assert_eq!(fixture.fake().flushes, 1);
}
