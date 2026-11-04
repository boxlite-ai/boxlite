// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::sync::{
    Arc,
    atomic::{AtomicU8, AtomicUsize, Ordering},
};

use virtio_queue::{Queue, QueueT, desc::split::Descriptor};
use vm_memory::{Bytes, GuestMemoryBackend, GuestMemoryRegion};

use super::*;
use crate::{
    events::EventLoop,
    virtio::{
        EventError, EventRegistrar, EventSource, SourceId, VirtioInterrupt, queue::VirtQueues,
    },
};

const DATA: u64 = 0x10_0000;
const RAM_LEN: usize = 0x40_0000;
const SIZE: u16 = 8;
const WRITE: u16 = 2;
const NEXT: u16 = 1;

fn desc(queue: usize) -> u64 {
    0x1000 + queue as u64 * 0x10000
}
fn avail(queue: usize) -> u64 {
    0x4000 + queue as u64 * 0x10000
}
fn used(queue: usize) -> u64 {
    0x8000 + queue as u64 * 0x10000
}

#[derive(Default)]
struct Interrupt {
    status: AtomicU8,
    raised: AtomicUsize,
    reuse: Option<Arc<GuestMemoryMmap>>,
}

impl VirtioInterrupt for Interrupt {
    fn raise(&self) {
        self.raised.fetch_add(1, Ordering::SeqCst);
        if let Some(memory) = &self.reuse {
            assert_eq!(read_u16(memory, used(2) + 2), 1);
            #[cfg(target_os = "linux")]
            assert_eq!(memory.read_obj::<u8>(GuestAddress(DATA)).unwrap(), 0);
            memory.write_obj(0x77u8, GuestAddress(DATA)).unwrap();
        }
    }
    fn interrupt_status(&self) -> u8 {
        0
    }
    fn ack_interrupt(&self, _: u8) {}
    fn config_generation(&self) -> u8 {
        0
    }
    fn raise_config(&self) {}
    fn device_status(&self) -> u8 {
        self.status.load(Ordering::SeqCst)
    }
    fn set_device_status(&self, status: u8) {
        self.status.store(status, Ordering::SeqCst);
    }
    fn set_needs_reset(&self) {
        self.status
            .fetch_or(crate::virtio::NEEDS_RESET, Ordering::SeqCst);
    }
}

struct NoSources;
impl EventRegistrar for NoSources {
    fn register(&self, _: Box<dyn EventSource>) -> Result<SourceId, EventError> {
        Err(EventError::Closed)
    }
    fn deregister(&self, _: SourceId) {}
}

fn memory() -> Arc<GuestMemoryMmap> {
    Arc::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), RAM_LEN)]).unwrap())
}

fn queue(index: usize, ready: bool, size: u16) -> Queue {
    let mut queue = Queue::new(256).unwrap();
    queue.try_set_size(size).unwrap();
    queue
        .try_set_desc_table_address(GuestAddress(desc(index)))
        .unwrap();
    queue
        .try_set_avail_ring_address(GuestAddress(avail(index)))
        .unwrap();
    queue
        .try_set_used_ring_address(GuestAddress(used(index)))
        .unwrap();
    queue.set_ready(ready);
    queue
}

fn context(
    memory: &Arc<GuestMemoryMmap>,
    ready: [bool; 3],
    size: u16,
    interrupt: Arc<Interrupt>,
) -> ActivationContext {
    let queues = VirtQueues::prepare(
        (0..3)
            .map(|index| queue(index, ready[index], size))
            .collect(),
        SPEC.queue_max,
        false,
        false,
        Arc::clone(memory),
    )
    .unwrap();
    ActivationContext {
        memory: Arc::clone(memory),
        queues,
        interrupt,
        events: Arc::new(NoSources),
        waker: Arc::new(|| {}),
        sender: EventLoop::new().unwrap().sender(),
    }
}

fn activated(memory: &Arc<GuestMemoryMmap>) -> (VirtioBalloon, Arc<Interrupt>) {
    activated_with(memory, ReclaimPolicy::Immediate)
}

fn activated_with(
    memory: &Arc<GuestMemoryMmap>,
    reclaim: ReclaimPolicy,
) -> (VirtioBalloon, Arc<Interrupt>) {
    let interrupt = Arc::new(Interrupt::default());
    let mut balloon = VirtioBalloon::new(reclaim).unwrap();
    balloon.set_features(REPORTING).unwrap();
    balloon
        .activate(context(memory, [true; 3], SIZE, Arc::clone(&interrupt)))
        .unwrap();
    (balloon, interrupt)
}

fn write_desc(
    memory: &GuestMemoryMmap,
    queue: usize,
    index: u16,
    address: u64,
    len: u32,
    flags: u16,
    next: u16,
) {
    memory
        .write_obj(
            Descriptor::new(address, len, flags, next),
            GuestAddress(desc(queue) + 16 * u64::from(index)),
        )
        .unwrap();
}

fn submit(memory: &GuestMemoryMmap, queue: usize, head: u16) {
    memory
        .write_obj(head.to_le(), GuestAddress(avail(queue) + 4))
        .unwrap();
    memory
        .write_obj(1u16.to_le(), GuestAddress(avail(queue) + 2))
        .unwrap();
}

fn read_u16(memory: &GuestMemoryMmap, address: u64) -> u16 {
    u16::from_le(memory.read_obj(GuestAddress(address)).unwrap())
}

fn touch(memory: &GuestMemoryMmap, address: u64, pages: usize) {
    let page = host_page_size().unwrap();
    for index in 0..pages {
        memory
            .write_obj(0x5au8, GuestAddress(address + (index * page) as u64))
            .unwrap();
    }
}

#[cfg(target_os = "linux")]
fn resident(memory: &GuestMemoryMmap, address: u64, pages: usize) -> usize {
    let page = host_page_size().unwrap();
    let slice = memory
        .get_slice(GuestAddress(address), pages * page)
        .unwrap();
    let guard = slice.ptr_guard();
    let mut residency = vec![0u8; pages];
    // SAFETY: the guard keeps this page-aligned RAM mapping alive, and the
    // vector has one output byte for each queried host page.
    assert_eq!(
        unsafe {
            libc::mincore(
                guard.as_ptr() as *mut libc::c_void,
                pages * page,
                residency.as_mut_ptr(),
            )
        },
        0
    );
    residency.iter().filter(|byte| **byte & 1 != 0).count()
}

#[cfg(target_os = "linux")]
fn lazy_free_kib() -> u64 {
    std::fs::read_to_string("/proc/self/smaps_rollup")
        .expect("read smaps_rollup")
        .lines()
        .find_map(|line| line.strip_prefix("LazyFree:"))
        .expect("LazyFree in smaps_rollup")
        .trim()
        .trim_end_matches(" kB")
        .parse()
        .expect("LazyFree value")
}

#[test]
fn balloon_spec_config_partial_actual_and_reset() {
    let mut balloon = VirtioBalloon::new(ReclaimPolicy::Immediate).unwrap();
    assert_eq!(
        balloon.set_features(REPORTING | 1).unwrap_err().unsupported,
        1
    );
    balloon.set_features(REPORTING).unwrap();
    balloon.write_config(0, &[0xff; 8]).unwrap();
    balloon.write_config(5, &[0x12, 0x34]).unwrap();
    let mut config = [0xff; 8];
    balloon.read_config(0, &mut config).unwrap();
    assert_eq!(config, [0, 0, 0, 0, 0xff, 0x12, 0x34, 0xff]);
    let memory = memory();
    balloon
        .activate(context(
            &memory,
            [true; 3],
            SIZE,
            Arc::new(Interrupt::default()),
        ))
        .unwrap();
    balloon.reset().unwrap();
    balloon.read_config(0, &mut config).unwrap();
    assert_eq!(config, [0; 8]);
    assert_eq!(balloon.features, 0);
    assert!(balloon.context.is_none());
    assert_eq!(balloon.control_count, 0);
    assert!(matches!(
        balloon.on_event(DeviceEvent::QueueKick(0)),
        Err(DeviceError::NeedsReset(_))
    ));
    balloon
        .activate(context(
            &memory,
            [true, true, false],
            SIZE,
            Arc::new(Interrupt::default()),
        ))
        .unwrap();
}

#[test]
fn balloon_activation_requires_only_negotiated_queues() {
    for ready in [
        [false, true, true],
        [true, false, true],
        [true, true, false],
    ] {
        let memory = memory();
        let mut balloon = VirtioBalloon::new(ReclaimPolicy::Immediate).unwrap();
        balloon.set_features(REPORTING).unwrap();
        assert!(matches!(
            balloon.activate(context(
                &memory,
                ready,
                SIZE,
                Arc::new(Interrupt::default())
            )),
            Err(DeviceError::NeedsReset(_))
        ));
    }
    let memory = memory();
    let mut balloon = VirtioBalloon::new(ReclaimPolicy::Immediate).unwrap();
    balloon
        .activate(context(
            &memory,
            [true, true, false],
            SIZE,
            Arc::new(Interrupt::default()),
        ))
        .unwrap();
    balloon.on_event(DeviceEvent::QueueKick(2)).unwrap();
}

#[test]
fn balloon_unnegotiated_reporting_never_consumes_a_ready_ring() {
    let memory = memory();
    let mut balloon = VirtioBalloon::new(ReclaimPolicy::Immediate).unwrap();
    balloon
        .activate(context(
            &memory,
            [true; 3],
            SIZE,
            Arc::new(Interrupt::default()),
        ))
        .unwrap();
    touch(&memory, DATA, 1);
    write_desc(
        &memory,
        2,
        0,
        DATA,
        host_page_size().unwrap() as u32,
        WRITE,
        0,
    );
    submit(&memory, 2, 0);
    balloon.on_event(DeviceEvent::QueueKick(2)).unwrap();
    assert_eq!(read_u16(&memory, used(2) + 2), 0);
    assert_eq!(memory.read_obj::<u8>(GuestAddress(DATA)).unwrap(), 0x5a);
}

#[test]
fn balloon_inflate_deflate_accept_empty_but_reject_any_chain() {
    for index in 0..2 {
        let memory = memory();
        let (mut balloon, interrupt) = activated(&memory);
        balloon.on_event(DeviceEvent::QueueKick(index)).unwrap();
        assert_eq!(interrupt.raised.load(Ordering::SeqCst), 0);
        write_desc(&memory, index as usize, 0, DATA, 0, WRITE, 0);
        submit(&memory, index as usize, 0);
        assert!(matches!(
            balloon.on_event(DeviceEvent::QueueKick(index)),
            Err(DeviceError::NeedsReset(_))
        ));
        assert_eq!(read_u16(&memory, used(index as usize) + 2), 0);
    }
}

#[test]
fn balloon_real_split_ring_reclaims_backing_then_reuses_same_capacity() {
    let memory = memory();
    let (mut balloon, interrupt) = activated(&memory);
    let page = host_page_size().unwrap();
    touch(&memory, DATA, 5);
    #[cfg(target_os = "linux")]
    assert_eq!(resident(&memory, DATA, 5), 5);
    write_desc(
        &memory,
        2,
        0,
        DATA + page as u64,
        (2 * page) as u32,
        WRITE | NEXT,
        1,
    );
    write_desc(
        &memory,
        2,
        1,
        DATA + (3 * page) as u64,
        page as u32,
        WRITE,
        0,
    );
    submit(&memory, 2, 0);
    balloon.on_event(DeviceEvent::QueueKick(2)).unwrap();
    assert_eq!(read_u16(&memory, used(2) + 2), 1);
    assert_eq!(
        u32::from_le(memory.read_obj::<u32>(GuestAddress(used(2) + 4)).unwrap()),
        0
    );
    assert_eq!(
        u32::from_le(memory.read_obj::<u32>(GuestAddress(used(2) + 8)).unwrap()),
        0
    );
    assert_eq!(interrupt.raised.load(Ordering::SeqCst), 1);
    #[cfg(target_os = "linux")]
    assert_eq!(resident(&memory, DATA, 5), 2);
    assert_eq!(memory.read_obj::<u8>(GuestAddress(DATA)).unwrap(), 0x5a);
    assert_eq!(
        memory
            .read_obj::<u8>(GuestAddress(DATA + (4 * page) as u64))
            .unwrap(),
        0x5a
    );
    touch(&memory, DATA, 5);
    for index in 0..5 {
        assert_eq!(
            memory
                .read_obj::<u8>(GuestAddress(DATA + (index * page) as u64))
                .unwrap(),
            0x5a
        );
    }
    assert_eq!(
        memory.iter().map(|region| region.len()).sum::<u64>(),
        RAM_LEN as u64
    );
}

#[cfg(target_os = "linux")]
#[test]
fn balloon_lazy_policy_marks_reported_pages_without_discarding_them() {
    let memory = memory();
    let (mut balloon, interrupt) = activated_with(&memory, ReclaimPolicy::Lazy);
    let page = host_page_size().unwrap();
    // MADV_FREE may skip a sub-folio range, so report a whole MiB.
    let pages = (1 << 20) / page;
    touch(&memory, DATA, pages);
    assert_eq!(resident(&memory, DATA, pages), pages);
    let lazy_before = lazy_free_kib();
    write_desc(&memory, 2, 0, DATA, (pages * page) as u32, WRITE, 0);
    submit(&memory, 2, 0);
    balloon.on_event(DeviceEvent::QueueKick(2)).unwrap();
    assert_eq!(read_u16(&memory, used(2) + 2), 1);
    assert_eq!(interrupt.raised.load(Ordering::SeqCst), 1);
    // MADV_FREE marks the range; it does not discard it now.
    assert_eq!(resident(&memory, DATA, pages), pages);
    assert!(
        lazy_free_kib() > lazy_before,
        "the report must mark its range reclaimable"
    );
    for index in 0..pages {
        let address = GuestAddress(DATA + (index * page) as u64);
        memory.write_obj(0x77u8, address).unwrap();
        assert_eq!(memory.read_obj::<u8>(address).unwrap(), 0x77);
    }
}

#[test]
fn balloon_malformed_second_descriptor_never_reclaims_valid_prefix() {
    let page = host_page_size().unwrap() as u32;
    for (address, len, flags, next) in [
        (DATA + u64::from(page), 0, WRITE, 0),
        (DATA + u64::from(page), page, 0, 0),
        (u64::MAX - 1, page, WRITE, 0),
        (RAM_LEN as u64, page, WRITE, 0),
        (RAM_LEN as u64 - u64::from(page), page + 1, WRITE, 0),
        (DATA + u64::from(page), page, WRITE | NEXT, SIZE),
        (DATA + u64::from(page), page, WRITE | NEXT, 1),
    ] {
        let memory = memory();
        let (mut balloon, _) = activated(&memory);
        touch(&memory, DATA, 2);
        write_desc(&memory, 2, 0, DATA, page, WRITE | NEXT, 1);
        write_desc(&memory, 2, 1, address, len, flags, next);
        submit(&memory, 2, 0);
        assert!(
            matches!(
                balloon.on_event(DeviceEvent::QueueKick(2)),
                Err(DeviceError::NeedsReset(_))
            ),
            "address={address:#x} len={len} flags={flags}"
        );
        assert_eq!(read_u16(&memory, used(2) + 2), 0);
        #[cfg(target_os = "linux")]
        assert_eq!(resident(&memory, DATA, 2), 2);
        assert_eq!(memory.read_obj::<u8>(GuestAddress(DATA)).unwrap(), 0x5a);
    }
}

#[test]
fn balloon_queue_control_ranges_reject_raw_overlap_on_all_ready_queues() {
    for index in 0..9 {
        let memory = memory();
        let (mut balloon, _) = activated(&memory);
        let (start, len, _) = balloon.control_ranges[index];
        let sentinel = GuestAddress(start.0 + len as u64 - 1);
        memory.write_obj(0x6bu8, sentinel).unwrap();
        touch(&memory, DATA, 1);
        write_desc(
            &memory,
            2,
            0,
            DATA,
            host_page_size().unwrap() as u32,
            WRITE | NEXT,
            1,
        );
        // One byte in an event field or final descriptor byte must be rejected
        // even though rounding inward would yield no reclaimable page.
        write_desc(&memory, 2, 1, sentinel.0, 1, WRITE, 0);
        submit(&memory, 2, 0);
        assert!(matches!(
            balloon.on_event(DeviceEvent::QueueKick(2)),
            Err(DeviceError::NeedsReset(_))
        ));
        assert_eq!(memory.read_obj::<u8>(sentinel).unwrap(), 0x6b);
        assert_eq!(memory.read_obj::<u8>(GuestAddress(DATA)).unwrap(), 0x5a);
        assert_eq!(read_u16(&memory, used(2) + 2), 0);
    }
}

#[test]
fn balloon_invalid_head_is_not_an_empty_successful_report() {
    let memory = memory();
    let (mut balloon, _) = activated(&memory);
    submit(&memory, 2, SIZE);
    assert!(matches!(
        balloon.on_event(DeviceEvent::QueueKick(2)),
        Err(DeviceError::NeedsReset(_))
    ));
    assert_eq!(read_u16(&memory, used(2) + 2), 0);
}

#[test]
fn balloon_adjacent_regions_and_holes_are_not_single_report_ranges() {
    for second in [RAM_LEN as u64, RAM_LEN as u64 + 0x10000] {
        let memory = Arc::new(
            GuestMemoryMmap::from_ranges(&[
                (GuestAddress(0), RAM_LEN),
                (GuestAddress(second), 0x10000),
            ])
            .unwrap(),
        );
        let (mut balloon, _) = activated(&memory);
        touch(&memory, DATA, 1);
        write_desc(
            &memory,
            2,
            0,
            DATA,
            host_page_size().unwrap() as u32,
            WRITE | NEXT,
            1,
        );
        write_desc(
            &memory,
            2,
            1,
            RAM_LEN as u64 - 1,
            (second - RAM_LEN as u64 + 2) as u32,
            WRITE,
            0,
        );
        submit(&memory, 2, 0);
        assert!(matches!(
            balloon.on_event(DeviceEvent::QueueKick(2)),
            Err(DeviceError::NeedsReset(_))
        ));
        assert_eq!(memory.read_obj::<u8>(GuestAddress(DATA)).unwrap(), 0x5a);
    }
}

#[test]
fn balloon_silent_total_byte_overflow_does_not_reclaim_prefix() {
    // A large virtual mapping, not a resident allocation, lets the first huge
    // descriptor validate before the dependency truncates its overflowing tail.
    let memory =
        Arc::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x1_1000_0000)]).unwrap());
    let (mut balloon, _) = activated(&memory);
    touch(&memory, DATA, 1);
    write_desc(&memory, 2, 0, DATA, u32::MAX, WRITE | NEXT, 1);
    write_desc(&memory, 2, 1, DATA, 1, WRITE, 0);
    submit(&memory, 2, 0);
    assert!(matches!(
        balloon.on_event(DeviceEvent::QueueKick(2)),
        Err(DeviceError::NeedsReset(_))
    ));
    assert_eq!(memory.read_obj::<u8>(GuestAddress(DATA)).unwrap(), 0x5a);
    assert_eq!(read_u16(&memory, used(2) + 2), 0);
}

#[test]
fn balloon_maximum_chain_uses_bounded_metadata() {
    let memory = memory();
    let mut balloon = VirtioBalloon::new(ReclaimPolicy::Immediate).unwrap();
    balloon.set_features(REPORTING).unwrap();
    balloon
        .activate(context(
            &memory,
            [true; 3],
            256,
            Arc::new(Interrupt::default()),
        ))
        .unwrap();
    touch(&memory, DATA, 1);
    let page = host_page_size().unwrap() as u32;
    for index in 0..256 {
        let flags = if index == 255 { WRITE } else { WRITE | NEXT };
        write_desc(&memory, 2, index, DATA, page, flags, index.wrapping_add(1));
    }
    submit(&memory, 2, 0);
    balloon.on_event(DeviceEvent::QueueKick(2)).unwrap();
    assert_eq!(read_u16(&memory, used(2) + 2), 1);
}

#[test]
fn balloon_guest_reuse_at_used_notification_has_no_later_reclaim() {
    let memory = memory();
    let interrupt = Arc::new(Interrupt {
        reuse: Some(Arc::clone(&memory)),
        ..Interrupt::default()
    });
    let mut balloon = VirtioBalloon::new(ReclaimPolicy::Immediate).unwrap();
    balloon.set_features(REPORTING).unwrap();
    balloon
        .activate(context(&memory, [true; 3], SIZE, interrupt))
        .unwrap();
    touch(&memory, DATA, 1);
    write_desc(
        &memory,
        2,
        0,
        DATA,
        host_page_size().unwrap() as u32,
        WRITE,
        0,
    );
    submit(&memory, 2, 0);
    balloon.on_event(DeviceEvent::QueueKick(2)).unwrap();
    balloon.on_event(DeviceEvent::QueueKick(2)).unwrap();
    assert_eq!(memory.read_obj::<u8>(GuestAddress(DATA)).unwrap(), 0x77);
}

#[cfg(target_os = "linux")]
#[test]
fn balloon_os_reclaim_error_still_completes_without_deferred_retry() {
    let memory = memory();
    let (mut balloon, interrupt) = activated(&memory);
    let page = host_page_size().unwrap();
    touch(&memory, DATA, 2);
    let slice = memory.get_slice(GuestAddress(DATA), page).unwrap();
    let guard = slice.ptr_guard();
    // SAFETY: locking this live page does not alter its mapping or access model.
    // Linux rejects MADV_DONTNEED on locked pages with EINVAL.
    assert_eq!(unsafe { libc::mlock(guard.as_ptr().cast(), page) }, 0);
    let error = ReclaimRange::new(&memory, GuestAddress(DATA), page, page)
        .unwrap()
        .reclaim(ReclaimPolicy::Immediate)
        .unwrap_err();
    assert_eq!(error.raw_os_error(), Some(libc::EINVAL));
    write_desc(&memory, 2, 0, DATA, page as u32, WRITE | NEXT, 1);
    write_desc(&memory, 2, 1, DATA + page as u64, page as u32, WRITE, 0);
    submit(&memory, 2, 0);
    balloon.on_event(DeviceEvent::QueueKick(2)).unwrap();
    assert_eq!(read_u16(&memory, used(2) + 2), 1);
    assert_eq!(interrupt.raised.load(Ordering::SeqCst), 1);
    assert_eq!(memory.read_obj::<u8>(GuestAddress(DATA)).unwrap(), 0x5a);
    assert_eq!(
        memory
            .read_obj::<u8>(GuestAddress(DATA + page as u64))
            .unwrap(),
        0
    );
    memory
        .write_obj(0x78u8, GuestAddress(DATA + page as u64))
        .unwrap();
    // SAFETY: undo exactly the lock established above on the live mapping.
    assert_eq!(unsafe { libc::munlock(guard.as_ptr().cast(), page) }, 0);
    memory.write_obj(0x77u8, GuestAddress(DATA)).unwrap();
    balloon.on_event(DeviceEvent::QueueKick(2)).unwrap();
    assert_eq!(memory.read_obj::<u8>(GuestAddress(DATA)).unwrap(), 0x77);
    assert_eq!(
        memory
            .read_obj::<u8>(GuestAddress(DATA + page as u64))
            .unwrap(),
        0x78
    );
    assert_eq!(read_u16(&memory, used(2) + 2), 1);
}

#[test]
fn balloon_config_writes_only_actual_bytes_even_across_boundaries() {
    let mut balloon = VirtioBalloon::new(ReclaimPolicy::Immediate).unwrap();
    balloon.write_config(3, &[0x11, 0x22, 0x33]).unwrap();
    balloon.write_config(7, &[0x44, 0x55]).unwrap();
    balloon.write_config(u64::MAX, &[0xff, 0xff]).unwrap();
    let mut config = [0; 10];
    balloon.read_config(0, &mut config).unwrap();
    assert_eq!(config, [0, 0, 0, 0, 0x22, 0x33, 0, 0x44, 0, 0]);
    balloon.read_config(u64::MAX, &mut config).unwrap();
    assert_eq!(config, [0; 10]);
}

#[test]
fn balloon_indirect_report_is_rejected_without_touching_page_backing() {
    let memory = memory();
    let (mut balloon, _) = activated(&memory);
    touch(&memory, DATA, 1);
    write_desc(&memory, 2, 0, DATA, 16, 4, 0);
    submit(&memory, 2, 0);
    assert!(matches!(
        balloon.on_event(DeviceEvent::QueueKick(2)),
        Err(DeviceError::NeedsReset(_))
    ));
    assert_eq!(read_u16(&memory, used(2) + 2), 0);
    assert_eq!(memory.read_obj::<u8>(GuestAddress(DATA)).unwrap(), 0x5a);
}

#[test]
fn overlapping_and_duplicate_reports_complete_in_original_order() {
    let memory = memory();
    let (mut balloon, _) = activated(&memory);
    let page = host_page_size().unwrap();
    touch(&memory, DATA, 5);
    for (index, start) in [
        DATA + page as u64,
        DATA + page as u64,
        DATA + 2 * page as u64,
    ]
    .into_iter()
    .enumerate()
    {
        write_desc(
            &memory,
            2,
            index as u16,
            start,
            (2 * page) as u32,
            if index == 2 { WRITE } else { WRITE | NEXT },
            (index + 1) as u16,
        );
    }
    submit(&memory, 2, 0);
    balloon.on_event(DeviceEvent::QueueKick(2)).unwrap();
    assert_eq!(read_u16(&memory, used(2) + 2), 1);
    #[cfg(target_os = "linux")]
    assert_eq!(resident(&memory, DATA, 5), 2);
    assert_eq!(memory.read_obj::<u8>(GuestAddress(DATA)).unwrap(), 0x5a);
    assert_eq!(
        memory
            .read_obj::<u8>(GuestAddress(DATA + 4 * page as u64))
            .unwrap(),
        0x5a
    );
    touch(&memory, DATA, 5);
}

#[test]
fn ttl_exhaustion_rejects_entire_cycle_without_reclaiming_prefix() {
    let memory = memory();
    let (mut balloon, _) = activated(&memory);
    let page = host_page_size().unwrap();
    touch(&memory, DATA, 1);
    for index in 0..SIZE {
        write_desc(
            &memory,
            2,
            index,
            DATA,
            page as u32,
            WRITE | NEXT,
            (index + 1) % SIZE,
        );
    }
    submit(&memory, 2, 0);
    assert!(matches!(
        balloon.on_event(DeviceEvent::QueueKick(2)),
        Err(DeviceError::NeedsReset(_))
    ));
    assert_eq!(read_u16(&memory, used(2) + 2), 0);
    assert_eq!(memory.read_obj::<u8>(GuestAddress(DATA)).unwrap(), 0x5a);
}

#[test]
fn four_kib_report_with_sixteen_kib_granularity_preserves_neighbours_and_completes() {
    let memory = memory();
    let (mut balloon, _) = activated(&memory);
    // Exercise the real report/used path with a larger host granularity.
    balloon.page_size = 16384;
    for offset in [0, 4096, 8192] {
        memory
            .write_obj(0x5au8, GuestAddress(DATA + offset))
            .unwrap();
    }
    write_desc(&memory, 2, 0, DATA + 4096, 4096, WRITE, 0);
    submit(&memory, 2, 0);
    balloon.on_event(DeviceEvent::QueueKick(2)).unwrap();
    assert_eq!(read_u16(&memory, used(2) + 2), 1);
    for offset in [0, 4096, 8192] {
        assert_eq!(
            memory.read_obj::<u8>(GuestAddress(DATA + offset)).unwrap(),
            0x5a
        );
    }
}

#[test]
fn report_hva_aliasing_control_gpa_is_rejected_before_any_reclaim() {
    use vm_memory::{GuestRegionMmap, MmapRegion};
    let owned =
        GuestRegionMmap::new(MmapRegion::<()>::new(RAM_LEN).unwrap(), GuestAddress(0)).unwrap();
    let alias_gpa = 0x80_0000;
    let page = host_page_size().unwrap();
    // SAFETY: owned remains in the same collection for the entire alias
    // lifetime; build_raw does not own/unmap its pointer. Only volatile APIs
    // access the shared bytes. This deliberately violates production's
    // no-alias constructor to exercise the independent HVA control guard.
    let alias = unsafe {
        MmapRegion::<()>::build_raw(
            owned.as_ptr().add(DATA as usize),
            page,
            libc::PROT_READ | libc::PROT_WRITE,
            libc::MAP_PRIVATE | libc::MAP_ANONYMOUS,
        )
    }
    .unwrap();
    let memory = Arc::new(
        GuestMemoryMmap::from_regions(vec![
            owned,
            GuestRegionMmap::new(alias, GuestAddress(alias_gpa)).unwrap(),
        ])
        .unwrap(),
    );
    let mut ctx = context(&memory, [true; 3], SIZE, Arc::new(Interrupt::default()));
    let mut queues: Vec<_> = (0..3).map(|index| queue(index, true, SIZE)).collect();
    queues[0]
        .try_set_desc_table_address(GuestAddress(alias_gpa))
        .unwrap();
    ctx.queues =
        VirtQueues::prepare(queues, SPEC.queue_max, false, false, Arc::clone(&memory)).unwrap();
    let mut balloon = VirtioBalloon::new(ReclaimPolicy::Immediate).unwrap();
    balloon.set_features(REPORTING).unwrap();
    balloon.activate(ctx).unwrap();
    touch(&memory, DATA, 2);
    write_desc(
        &memory,
        2,
        0,
        DATA + page as u64,
        page as u32,
        WRITE | NEXT,
        1,
    );
    write_desc(&memory, 2, 1, DATA, page as u32, WRITE, 0);
    submit(&memory, 2, 0);
    assert!(matches!(
        balloon.on_event(DeviceEvent::QueueKick(2)),
        Err(DeviceError::NeedsReset(_))
    ));
    assert_eq!(read_u16(&memory, used(2) + 2), 0);
    assert_eq!(memory.read_obj::<u8>(GuestAddress(DATA)).unwrap(), 0x5a);
    assert_eq!(
        memory
            .read_obj::<u8>(GuestAddress(DATA + page as u64))
            .unwrap(),
        0x5a
    );
}

#[test]
fn activation_rejects_a_control_table_spanning_adjacent_regions() {
    let memory = Arc::new(
        GuestMemoryMmap::from_ranges(&[
            (GuestAddress(0), RAM_LEN),
            (GuestAddress(RAM_LEN as u64), 0x10000),
        ])
        .unwrap(),
    );
    let mut ctx = context(&memory, [true; 3], SIZE, Arc::new(Interrupt::default()));
    let mut queues: Vec<_> = (0..3).map(|index| queue(index, true, SIZE)).collect();
    queues[0]
        .try_set_desc_table_address(GuestAddress(RAM_LEN as u64 - 64))
        .unwrap();
    ctx.queues =
        VirtQueues::prepare(queues, SPEC.queue_max, false, false, Arc::clone(&memory)).unwrap();
    let mut balloon = VirtioBalloon::new(ReclaimPolicy::Immediate).unwrap();
    balloon.set_features(REPORTING).unwrap();
    assert!(matches!(
        balloon.activate(ctx),
        Err(DeviceError::NeedsReset(_))
    ));
    assert!(balloon.context.is_none());
}
