// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Production Fs requests through MMIO and SharedRuntime. The syscall gate and
//! write faults are injected, not evidence of slow or full host storage.

use std::{
    fs,
    os::unix::fs::MetadataExt,
    path::PathBuf,
    sync::{Arc, Condvar, Mutex},
    thread,
    time::{Duration, Instant},
};

use virtio_queue::desc::split::Descriptor;
use vm_memory::{ByteValued, Bytes, GuestAddress};

use crate::{
    bus::BusDevice,
    events::{Event, EventLoop},
    irq::IrqLine,
    memory::GuestMemoryMmap,
    mock_vm::MockVm,
    virtio::{
        VirtioInterrupt,
        fs::{Share, device::Fs, fuse::*},
        interrupt::MmioInterrupt,
        mmio::{MmioResources, MmioTransport},
        worker::{SharedRuntime, Timeouts, VirtioWorkers},
    },
};

const WAIT: Duration = Duration::from_secs(5);
const DESC: u64 = 0x2000;
const AVAIL: u64 = 0x3000;
const USED: u64 = 0x4000;
const REQUEST: u64 = 0x8000;
const RESPONSE: u64 = 0xa000;
static SERIAL: Mutex<()> = Mutex::new(());
static FAULT: Mutex<Option<Arc<Fault>>> = Mutex::new(None);

struct Fault {
    identity: (u64, u64),
    state: Mutex<(bool, bool)>,
    changed: Condvar,
    write: Option<usize>,
    expired: std::sync::atomic::AtomicBool,
    sync_error: std::sync::atomic::AtomicBool,
    sync_result: Mutex<Option<(bool, i32)>>,
}

impl Fault {
    fn install(path: &std::path::Path, write: Option<usize>) -> Arc<Self> {
        let metadata = fs::metadata(path).unwrap();
        let fault = Arc::new(Self {
            identity: (metadata.dev(), metadata.ino()),
            state: Mutex::new((false, false)),
            changed: Condvar::new(),
            write,
            expired: std::sync::atomic::AtomicBool::new(false),
            sync_error: std::sync::atomic::AtomicBool::new(false),
            sync_result: Mutex::new(None),
        });
        *FAULT.lock().unwrap() = Some(fault.clone());
        fault
    }

    fn entered(&self) {
        let (state, _) = self
            .changed
            .wait_timeout_while(self.state.lock().unwrap(), WAIT, |state| !state.0)
            .unwrap();
        assert!(state.0, "Fs did not enter the injected host syscall gate");
    }

    fn wait(&self) {
        let mut state = self.state.lock().unwrap();
        state.0 = true;
        self.changed.notify_all();
        let (state, _) = self
            .changed
            .wait_timeout_while(state, WAIT, |state| !state.1)
            .unwrap();
        if !state.1 {
            self.expired
                .store(true, std::sync::atomic::Ordering::Release);
        }
    }

    fn open(&self) {
        self.state.lock().unwrap().1 = true;
        self.changed.notify_all();
    }
}

fn fault(fd: i32) -> Option<Arc<Fault>> {
    if thread::current().name() != Some("virtio-worker") {
        return None;
    }
    let current = FAULT.lock().unwrap().clone()?;
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    // SAFETY: fstat initializes stat on success; fd is borrowed for this call.
    if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
        return None;
    }
    // SAFETY: successful fstat initialized the object.
    let stat = unsafe { stat.assume_init() };
    (current.identity == (stat.st_dev, stat.st_ino)).then_some(current)
}

#[unsafe(export_name = "pread64")]
unsafe extern "C" fn injected_pread(
    fd: i32,
    buf: *mut libc::c_void,
    count: usize,
    offset: i64,
) -> isize {
    if let Some(fault) = fault(fd) {
        fault.wait();
    }
    // SAFETY: forward the unchanged libc ABI to the kernel.
    unsafe { libc::syscall(libc::SYS_pread64, fd, buf, count, offset) as isize }
}

fn host_sync(fd: i32, data_only: bool) -> i32 {
    let injected = fault(fd);
    if let Some(fault) = &injected {
        fault.wait();
        if fault.sync_error.load(std::sync::atomic::Ordering::Acquire) {
            // SAFETY: errno belongs to this calling thread.
            unsafe {
                *libc::__errno_location() = libc::EIO;
            }
            *fault.sync_result.lock().unwrap() = Some((data_only, -1));
            return -1;
        }
    }
    let syscall = if data_only {
        libc::SYS_fdatasync
    } else {
        libc::SYS_fsync
    };
    // SAFETY: forward the borrowed descriptor to the matching Linux syscall.
    let result = unsafe { libc::syscall(syscall, fd) as i32 };
    if let Some(fault) = injected {
        *fault.sync_result.lock().unwrap() = Some((data_only, result));
    }
    result
}

#[unsafe(export_name = "fsync")]
unsafe extern "C" fn injected_fsync(fd: i32) -> i32 {
    host_sync(fd, false)
}

#[unsafe(export_name = "fdatasync")]
unsafe extern "C" fn injected_fdatasync(fd: i32) -> i32 {
    host_sync(fd, true)
}

#[unsafe(export_name = "pwrite64")]
unsafe extern "C" fn injected_pwrite(
    fd: i32,
    buf: *const libc::c_void,
    count: usize,
    offset: i64,
) -> isize {
    let count = if let Some(fault) = fault(fd) {
        match fault.write {
            Some(0) => {
                // SAFETY: errno belongs to the calling thread.
                unsafe {
                    *libc::__errno_location() = libc::ENOSPC;
                }
                return -1;
            }
            Some(limit) => count.min(limit),
            None => count,
        }
    } else {
        count
    };
    // SAFETY: forward the caller's valid buffer, with at most its original count.
    unsafe { libc::syscall(libc::SYS_pwrite64, fd, buf, count, offset) as isize }
}

struct Guest {
    transport: MmioTransport,
    memory: Arc<GuestMemoryMmap>,
    next: u16,
    worker: Arc<dyn crate::virtio::WorkerControl>,
}

fn write(transport: &mut MmioTransport, offset: u64, value: u32) {
    transport.write(offset, &value.to_le_bytes());
}

impl Guest {
    fn new(workers: &VirtioWorkers, events: &EventLoop, path: &std::path::Path) -> Self {
        let device = Arc::new(Mutex::new(
            Fs::new(
                "test",
                vec![Share {
                    name: "shared".into(),
                    path: path.into(),
                    read_only: false,
                }],
            )
            .unwrap(),
        ));
        let interrupt = Arc::new(MmioInterrupt::new(IrqLine::new(Arc::new(MockVm::new()), 5)));
        let worker = workers.add(
            device.clone(),
            interrupt.clone() as Arc<dyn VirtioInterrupt>,
        );
        let memory = Arc::new(GuestMemoryMmap::from_ranges(&[(GuestAddress(0), 0x10000)]).unwrap());
        let transport = MmioTransport::new(
            device,
            interrupt,
            MmioResources {
                memory: memory.clone(),
                sender: events.sender(),
                worker: worker.clone(),
            },
        )
        .unwrap();
        let mut guest = Self {
            transport,
            memory,
            next: 0,
            worker,
        };
        guest.activate();
        guest
    }

    fn activate(&mut self) {
        for (offset, value) in [(0x070, 1), (0x070, 3), (0x024, 1), (0x020, 1), (0x070, 0xb)] {
            write(&mut self.transport, offset, value);
        }
        for queue in 0..2 {
            for (offset, value) in [
                (0x030, queue),
                (0x038, 8),
                (0x080, DESC as u32 + queue * 0x100),
                (0x090, AVAIL as u32 + queue * 0x100),
                (0x0a0, USED as u32 + queue * 0x100),
                (0x044, 1),
            ] {
                write(&mut self.transport, offset, value);
            }
        }
        write(&mut self.transport, 0x070, 0xf);
        self.next = 0;
        self.request(
            Opcode::Init,
            0,
            InitInCompat {
                major: 7,
                minor: 41,
                max_readahead: 4096,
                flags: 0,
            }
            .as_slice(),
        );
    }

    fn submit(&mut self, opcode: Opcode, node: u64, body: &[u8]) {
        let header = InHeader {
            len: (size_of::<InHeader>() + body.len()) as u32,
            opcode: opcode as u32,
            nodeid: node,
            unique: u64::from(self.next) + 1,
            ..Default::default()
        };
        let mut input = header.as_slice().to_vec();
        input.extend_from_slice(body);
        self.memory
            .write_slice(&input, GuestAddress(REQUEST))
            .unwrap();
        self.memory
            .write_obj(
                Descriptor::new(REQUEST, input.len() as u32, 1, 1),
                GuestAddress(DESC + 0x100),
            )
            .unwrap();
        self.memory
            .write_obj(
                Descriptor::new(RESPONSE, 4096, 2, 0),
                GuestAddress(DESC + 0x110),
            )
            .unwrap();
        self.memory
            .write_obj(
                0u16,
                GuestAddress(AVAIL + 0x104 + u64::from(self.next % 8) * 2),
            )
            .unwrap();
        self.next += 1;
        self.memory
            .write_obj(self.next.to_le(), GuestAddress(AVAIL + 0x102))
            .unwrap();
        write(&mut self.transport, 0x050, 1);
    }

    fn complete(&self) -> Vec<u8> {
        let deadline = Instant::now() + WAIT;
        loop {
            let used: u16 = self.memory.read_obj(GuestAddress(USED + 0x102)).unwrap();
            if u16::from_le(used) == self.next {
                break;
            }
            assert!(Instant::now() < deadline, "Fs request did not complete");
            thread::sleep(Duration::from_millis(1));
        }
        let header: OutHeader = self.memory.read_obj(GuestAddress(RESPONSE)).unwrap();
        let mut bytes = vec![0; header.len as usize];
        self.memory
            .read_slice(&mut bytes, GuestAddress(RESPONSE))
            .unwrap();
        bytes
    }

    fn request(&mut self, opcode: Opcode, node: u64, body: &[u8]) -> Vec<u8> {
        self.submit(opcode, node, body);
        self.complete()
    }

    fn file_node(&mut self) -> u64 {
        let root = self.request(Opcode::Lookup, 1, b"shared\0");
        let root = object::<EntryOut>(&root[16..]).nodeid;
        let entry = self.request(Opcode::Lookup, root, b"file\0");
        object::<EntryOut>(&entry[16..]).nodeid
    }

    fn open_file(&mut self) -> (u64, u64) {
        let node = self.file_node();
        let reply = self.request(
            Opcode::Open,
            node,
            OpenIn {
                flags: libc::O_RDWR as u32,
                ..Default::default()
            }
            .as_slice(),
        );
        assert_eq!(object::<OutHeader>(&reply).error, 0);
        (node, object::<OpenOut>(&reply[16..]).fh)
    }
}

fn object<T: ByteValued>(bytes: &[u8]) -> T {
    *T::from_slice(&bytes[..size_of::<T>()]).unwrap()
}

struct Rig {
    path: PathBuf,
    workers: VirtioWorkers,
    events: EventLoop,
}
impl Rig {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("boxlite-fs-worker-{}", std::process::id()));
        fs::create_dir(&path).unwrap();
        fs::write(path.join("file"), b"host bytes").unwrap();
        let events = EventLoop::new().unwrap();
        let workers = VirtioWorkers::with_runtime(Arc::new(
            SharedRuntime::new(
                events.sender(),
                Timeouts {
                    stop: Duration::from_millis(200),
                    shutdown: Duration::from_millis(200),
                },
            )
            .unwrap(),
        ));
        Self {
            path,
            workers,
            events,
        }
    }
    fn guest(&self) -> Guest {
        Guest::new(&self.workers, &self.events, &self.path)
    }
}
impl Drop for Rig {
    fn drop(&mut self) {
        let fault = FAULT.lock().unwrap().take();
        if let Some(fault) = &fault {
            fault.open();
        }
        self.workers.shutdown().unwrap();
        if !thread::panicking()
            && let Some(fault) = fault
        {
            assert!(
                !fault.expired.load(std::sync::atomic::Ordering::Acquire),
                "syscall gate watchdog expired before explicit release"
            );
        }
        fs::remove_dir_all(&self.path).unwrap();
    }
}

#[test]
fn host_write_lease_blocks_real_open_delays_other_device_and_times_out_reset() {
    use std::os::fd::AsRawFd;
    if !super::backend_tests::isolated_fd_child("BOXLITE_FS_LEASE_CHILD") {
        return;
    }
    // SIGIO must be blocked before SharedRuntime creates its thread. The
    // isolated child consumes the kernel's lease-break notification below.
    let mut signals = std::mem::MaybeUninit::<libc::sigset_t>::uninit();
    // SAFETY: initialize a signal set, then block it in this isolated process's
    // only thread; subsequently created threads inherit the blocked mask.
    unsafe {
        libc::sigemptyset(signals.as_mut_ptr());
        libc::sigaddset(signals.as_mut_ptr(), libc::SIGIO);
        assert_eq!(
            libc::pthread_sigmask(libc::SIG_BLOCK, signals.as_ptr(), std::ptr::null_mut()),
            0
        );
    }
    // SAFETY: sigemptyset initialized the set.
    let signals = unsafe { signals.assume_init() };
    let mut rig = Rig::new();
    let mut guest = rig.guest();
    let mut other = rig.guest();
    let node = guest.file_node();
    let lease = Arc::new(
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(rig.path.join("file"))
            .unwrap(),
    );
    // libtest also has a harness thread with SIGIO unblocked. Route the lease
    // notification to this specific test thread rather than the whole process.
    #[repr(C)]
    struct Owner {
        kind: libc::c_int,
        pid: libc::pid_t,
    }
    let owner = Owner {
        kind: 0, // F_OWNER_TID in Linux fcntl.h.
        // SAFETY: gettid has no arguments or side effects.
        pid: unsafe { libc::syscall(libc::SYS_gettid) as libc::pid_t },
    };
    // SAFETY: Linux F_SETOWN_EX (15) reads a valid f_owner_ex layout.
    assert_eq!(unsafe { libc::fcntl(lease.as_raw_fd(), 15, &owner) }, 0);
    // SAFETY: this owned regular file is writable and belongs to the current uid.
    let result = unsafe { libc::fcntl(lease.as_raw_fd(), libc::F_SETLEASE, libc::F_WRLCK) };
    assert_eq!(
        result,
        0,
        "host filesystem must support owner file leases: {}",
        std::io::Error::last_os_error()
    );
    let (release, released) = std::sync::mpsc::channel();
    let held = lease.clone();
    let watchdog = thread::spawn(move || {
        // Release even if the test panics, and before the kernel lease timeout.
        let explicit = released.recv_timeout(WAIT);
        // SAFETY: held retains the leased file descriptor.
        assert_eq!(
            unsafe { libc::fcntl(held.as_raw_fd(), libc::F_SETLEASE, libc::F_UNLCK) },
            0
        );
        assert!(
            explicit.is_ok(),
            "lease watchdog released before explicit unlock"
        );
    });
    guest.submit(
        Opcode::Open,
        node,
        OpenIn {
            flags: libc::O_RDWR as u32,
            ..Default::default()
        }
        .as_slice(),
    );
    let timeout = libc::timespec {
        tv_sec: 5,
        tv_nsec: 0,
    };
    // SAFETY: signals and timeout are initialized; no siginfo is requested.
    assert_eq!(
        unsafe { libc::sigtimedwait(&signals, std::ptr::null_mut(), &timeout) },
        libc::SIGIO,
        "kernel did not report a conflicting host open"
    );
    other.submit(Opcode::Lookup, 1, b"shared\0");
    thread::sleep(Duration::from_millis(50));
    let used: u16 = other.memory.read_obj(GuestAddress(USED + 0x102)).unwrap();
    assert_eq!(u16::from_le(used), other.next - 1);
    write(&mut guest.transport, 0x070, 0);
    match rig.events.wait(Some(WAIT)).unwrap() {
        Some(Event::DeviceFailed(crate::error::Error::VirtioDevice { device, reason })) => {
            assert_eq!(device, "virtio-fs");
            assert_eq!(reason, "virtio worker stop timed out");
        }
        event => panic!("expected real lease-blocked OPEN timeout, got {event:?}"),
    }
    release.send(()).unwrap();
    watchdog.join().unwrap();
    assert_eq!(object::<OutHeader>(&guest.complete()).error, 0);
    assert_eq!(object::<OutHeader>(&other.complete()).error, 0);
    rig.workers.shutdown().unwrap();
}

#[test]
fn injected_host_read_delays_other_fs_device_until_released() {
    let _serial = SERIAL.lock().unwrap();
    let rig = Rig::new();
    let mut first = rig.guest();
    let mut other = rig.guest();
    let (node, fh) = first.open_file();
    let gate = Fault::install(&rig.path.join("file"), None);
    first.submit(
        Opcode::Read,
        node,
        ReadIn {
            fh,
            size: 10,
            ..Default::default()
        }
        .as_slice(),
    );
    gate.entered();
    let start = Instant::now();
    other.submit(Opcode::Lookup, 1, b"shared\0");
    thread::sleep(Duration::from_millis(50));
    let used: u16 = other.memory.read_obj(GuestAddress(USED + 0x102)).unwrap();
    assert_eq!(u16::from_le(used), other.next - 1);
    gate.open();
    assert_eq!(&first.complete()[16..], b"host bytes");
    assert_eq!(object::<OutHeader>(&other.complete()).error, 0);
    assert!(start.elapsed() >= Duration::from_millis(50));
}

#[test]
fn injected_host_read_stop_timeout_retains_guest_ram_until_shutdown_retry() {
    let _serial = SERIAL.lock().unwrap();
    let mut rig = Rig::new();
    let mut guest = rig.guest();
    let (node, fh) = guest.open_file();
    let memory = Arc::downgrade(&guest.memory);
    let gate = Fault::install(&rig.path.join("file"), None);
    guest.submit(
        Opcode::Read,
        node,
        ReadIn {
            fh,
            size: 10,
            ..Default::default()
        }
        .as_slice(),
    );
    gate.entered();
    write(&mut guest.transport, 0x070, 0);
    match rig.events.wait(Some(WAIT)).unwrap() {
        Some(Event::DeviceFailed(crate::error::Error::VirtioDevice { device, reason })) => {
            assert_eq!(device, "virtio-fs");
            assert_eq!(reason, "virtio worker stop timed out");
        }
        event => panic!("expected Fs stop timeout, got {event:?}"),
    }
    let error = rig.workers.shutdown().unwrap_err();
    assert!(matches!(error, crate::error::Error::VirtioWorker(error)
        if error.kind() == std::io::ErrorKind::TimedOut));
    drop(guest);
    assert!(
        memory.upgrade().is_some(),
        "in-flight production Fs must retain RAM"
    );
    gate.open();
    rig.workers.shutdown().unwrap();
    drop(rig);
    assert!(memory.upgrade().is_none());
}

#[test]
fn injected_host_read_reset_waits_and_succeeds_after_gate_release() {
    let _serial = SERIAL.lock().unwrap();
    let mut rig = Rig::new();
    let mut guest = rig.guest();
    let (node, fh) = guest.open_file();
    let gate = Fault::install(&rig.path.join("file"), None);
    guest.submit(
        Opcode::Read,
        node,
        ReadIn {
            fh,
            size: 10,
            ..Default::default()
        }
        .as_slice(),
    );
    gate.entered();
    let (started, entered) = std::sync::mpsc::channel();
    let (done, completed) = std::sync::mpsc::channel();
    let reset = thread::spawn(move || {
        started.send(()).unwrap();
        write(&mut guest.transport, 0x070, 0);
        done.send(guest).unwrap();
    });
    entered.recv_timeout(WAIT).unwrap();
    assert!(matches!(
        completed.recv_timeout(Duration::from_millis(50)),
        Err(std::sync::mpsc::RecvTimeoutError::Timeout)
    ));
    gate.open();
    let mut guest = completed.recv_timeout(WAIT).unwrap();
    reset.join().unwrap();
    let mut status = [0; 4];
    guest.transport.read(0x070, &mut status);
    assert_eq!(status, [0; 4]);
    assert_eq!(&guest.complete()[16..], b"host bytes");
    assert!(rig.events.wait(Some(Duration::ZERO)).unwrap().is_none());
}

#[test]
fn successful_reset_releases_populated_session_and_reactivates() {
    if !super::backend_tests::isolated_fd_child("BOXLITE_FS_MMIO_RESET_CHILD") {
        return;
    }
    let _serial = SERIAL.lock().unwrap();
    let rig = Rig::new();
    let mut guest = rig.guest();
    let baseline = super::backend_tests::fd_count();
    for _ in 0..16 {
        let (node, fh) = guest.open_file();
        let reply = guest.request(
            Opcode::Read,
            node,
            ReadIn {
                fh,
                size: 10,
                ..Default::default()
            }
            .as_slice(),
        );
        assert_eq!(&reply[16..], b"host bytes");
        write(&mut guest.transport, 0x070, 0);
        assert_eq!(super::backend_tests::fd_count(), baseline);
        let mut status = [0; 4];
        guest.transport.read(0x070, &mut status);
        assert_eq!(status, [0; 4]);
        // Clear the old ring indices before the next negotiated generation.
        for base in [AVAIL, USED] {
            for queue in 0..2 {
                guest
                    .memory
                    .write_obj(0u16, GuestAddress(base + queue * 0x100 + 2))
                    .unwrap();
            }
        }
        guest.activate();
        let reply = guest.request(
            Opcode::Read,
            node,
            ReadIn {
                fh,
                size: 10,
                ..Default::default()
            }
            .as_slice(),
        );
        assert_eq!(object::<OutHeader>(&reply).error, -libc::EBADF);
    }
}

#[test]
fn concurrent_producer_replenishes_fs_queue_while_transport_resets() {
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    let _serial = SERIAL.lock().unwrap();
    let mut rig = Rig::new();
    let mut guest = rig.guest();
    let memory = guest.memory.clone();
    let worker = guest.worker.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let count = Arc::new(AtomicUsize::new(0));
    let producer_stop = stop.clone();
    let produced = count.clone();
    let initial = guest.next;
    let producer = thread::spawn(move || {
        let deadline = Instant::now() + WAIT;
        let mut next = initial;
        while !producer_stop.load(Ordering::Acquire) && Instant::now() < deadline {
            let used: u16 = memory.read_obj(GuestAddress(USED + 0x102)).unwrap();
            // Four independent two-descriptor chains fill this eight-entry
            // descriptor table. Refill each slot only after its used entry.
            if next.wrapping_sub(u16::from_le(used)) >= 4 {
                thread::yield_now();
                continue;
            }
            let slot = next % 4;
            let head = slot * 2;
            let request = REQUEST + u64::from(slot) * 0x100;
            let response = RESPONSE + u64::from(slot) * 0x100;
            let header = InHeader {
                len: (size_of::<InHeader>() + 7) as u32,
                opcode: Opcode::Lookup as u32,
                nodeid: 1,
                unique: u64::from(next) + 1,
                ..Default::default()
            };
            let mut input = header.as_slice().to_vec();
            input.extend_from_slice(b"shared\0");
            memory.write_slice(&input, GuestAddress(request)).unwrap();
            memory
                .write_obj(
                    Descriptor::new(request, input.len() as u32, 1, head + 1),
                    GuestAddress(DESC + 0x100 + u64::from(head) * 16),
                )
                .unwrap();
            memory
                .write_obj(
                    Descriptor::new(response, 256, 2, 0),
                    GuestAddress(DESC + 0x100 + u64::from(head + 1) * 16),
                )
                .unwrap();
            memory
                .write_obj(
                    head.to_le(),
                    GuestAddress(AVAIL + 0x104 + u64::from(next % 8) * 2),
                )
                .unwrap();
            next = next.wrapping_add(1);
            memory
                .write_obj(next.to_le(), GuestAddress(AVAIL + 0x102))
                .unwrap();
            worker.kick(1);
            produced.fetch_add(1, Ordering::Release);
        }
        assert!(
            producer_stop.load(Ordering::Acquire),
            "producer watchdog expired before reset completed"
        );
    });
    let deadline = Instant::now() + WAIT;
    while count.load(Ordering::Acquire) < 128 {
        assert!(
            Instant::now() < deadline,
            "concurrent producer made no progress"
        );
        thread::yield_now();
    }
    // Four chains can remain outstanding while reset stops the live producer.
    let reset_started = Instant::now();
    write(&mut guest.transport, 0x070, 0);
    assert!(
        reset_started.elapsed() < Duration::from_secs(1),
        "reset must finish independently of the five-second producer watchdog"
    );
    stop.store(true, Ordering::Release);
    producer.join().unwrap();
    let mut status = [0; 4];
    guest.transport.read(0x070, &mut status);
    assert_eq!(status, [0; 4]);
    assert!(rig.events.wait(Some(Duration::ZERO)).unwrap().is_none());
}

#[test]
fn fsync_reply_waits_for_host_sync_result_and_propagates_injected_eio() {
    let _serial = SERIAL.lock().unwrap();
    let rig = Rig::new();
    let mut guest = rig.guest();
    let (node, fh) = guest.open_file();
    for data_only in [false, true] {
        for failed in [false, true] {
            let gate = Fault::install(&rig.path.join("file"), None);
            gate.sync_error
                .store(failed, std::sync::atomic::Ordering::Release);
            guest.submit(
                Opcode::Fsync,
                node,
                FsyncIn {
                    fh,
                    fsync_flags: u32::from(data_only),
                    ..Default::default()
                }
                .as_slice(),
            );
            gate.entered();
            thread::sleep(Duration::from_millis(50));
            let used: u16 = guest.memory.read_obj(GuestAddress(USED + 0x102)).unwrap();
            assert_eq!(
                u16::from_le(used),
                guest.next - 1,
                "FSYNC replied before the host syscall completed"
            );
            assert_eq!(*gate.sync_result.lock().unwrap(), None);
            gate.open();
            let reply = guest.complete();
            assert_eq!(
                object::<OutHeader>(&reply).error,
                if failed { -libc::EIO } else { 0 }
            );
            assert_eq!(
                *gate.sync_result.lock().unwrap(),
                Some((data_only, if failed { -1 } else { 0 }))
            );
            assert!(!gate.expired.load(std::sync::atomic::Ordering::Acquire));
        }
    }
}

#[test]
fn repeated_flush_keeps_handle_readable_until_release_and_forget_close_fds() {
    if !super::backend_tests::isolated_fd_child("BOXLITE_FS_FLUSH_CHILD") {
        return;
    }
    let _serial = SERIAL.lock().unwrap();
    let rig = Rig::new();
    let mut guest = rig.guest();
    let baseline = super::backend_tests::fd_count();
    let (node, fh) = guest.open_file();
    assert!(super::backend_tests::fd_count() > baseline);
    // Linux can send multiple FLUSH requests for dup/close on one FUSE fh.
    for _ in 0..3 {
        let reply = guest.request(
            Opcode::Flush,
            node,
            FlushIn {
                fh,
                ..Default::default()
            }
            .as_slice(),
        );
        assert_eq!(object::<OutHeader>(&reply).error, 0);
        let reply = guest.request(
            Opcode::Read,
            node,
            ReadIn {
                fh,
                size: 10,
                ..Default::default()
            }
            .as_slice(),
        );
        assert_eq!(&reply[16..], b"host bytes");
    }
    let reply = guest.request(
        Opcode::Release,
        node,
        ReleaseIn {
            fh,
            ..Default::default()
        }
        .as_slice(),
    );
    assert_eq!(object::<OutHeader>(&reply).error, 0);
    // FORGET has no reply; check its real used entry rather than stale output.
    guest.submit(Opcode::Forget, node, ForgetIn { nlookup: 1 }.as_slice());
    guest.complete();
    let length: u32 = guest
        .memory
        .read_obj(GuestAddress(
            USED + 0x108 + u64::from((guest.next - 1) % 8) * 8,
        ))
        .unwrap();
    assert_eq!(u32::from_le(length), 0);
    assert_eq!(super::backend_tests::fd_count(), baseline);
}

#[test]
fn injected_host_write_faults_return_actual_count_and_errno() {
    let _serial = SERIAL.lock().unwrap();
    let rig = Rig::new();
    let mut guest = rig.guest();
    let (node, fh) = guest.open_file();
    for (limit, expected) in [(3, 0), (0, -libc::ENOSPC)] {
        Fault::install(&rig.path.join("file"), Some(limit));
        let mut body = WriteIn {
            fh,
            size: 6,
            ..Default::default()
        }
        .as_slice()
        .to_vec();
        body.extend_from_slice(b"ABCDEF");
        let reply = guest.request(Opcode::Write, node, &body);
        assert_eq!(object::<OutHeader>(&reply).error, expected);
        if limit != 0 {
            assert_eq!(object::<WriteOut>(&reply[16..]).size, 3);
        }
        assert_eq!(fs::read(rig.path.join("file")).unwrap(), b"ABCt bytes");
    }
}
