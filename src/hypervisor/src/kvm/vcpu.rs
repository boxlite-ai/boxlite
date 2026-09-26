// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{io, marker::PhantomData, os::fd::AsRawFd, rc::Rc};

use kvm_bindings::{
    KVM_EXIT_HLT, KVM_EXIT_INTR, KVM_EXIT_IO, KVM_EXIT_IO_IN, KVM_EXIT_IO_OUT, KVM_EXIT_MMIO,
    KVM_EXIT_SHUTDOWN, KVM_EXIT_SYSTEM_EVENT, KVM_SYSTEM_EVENT_RESET, KVM_SYSTEM_EVENT_SHUTDOWN,
    kvm_run,
};
use kvm_ioctls::VcpuFd;

use super::{KvmVcpuHandle, kick::WorkerSignal};
use crate::{Error, Result, VcpuExit};

/// A Linux x86_64 vCPU bound to its creating thread.
///
/// Creation leaves KVM's reset register state intact and reserves the kick
/// signal on this worker until drop. Boot configuration follows in M1.
#[derive(Debug)]
pub struct KvmVcpu {
    pub(super) fd: VcpuFd,
    id: u32,
    run_size: usize,
    pending_io: PendingIo,
    kick: WorkerSignal,
    _thread_bound: PhantomData<Rc<()>>,
}

impl KvmVcpu {
    pub(super) fn new(fd: VcpuFd, id: u32, run_size: usize, signal: i32) -> io::Result<Self> {
        let kick = WorkerSignal::new(id, signal, fd.as_raw_fd())?;
        Ok(Self {
            fd,
            id,
            run_size,
            pending_io: PendingIo::default(),
            kick,
            _thread_bound: PhantomData,
        })
    }

    /// Returns a handle that interrupts this worker, including before entry.
    pub fn handle(&self) -> KvmVcpuHandle {
        self.kick.handle()
    }

    /// Runs until the next exit; handle borrowed device bytes before re-entry.
    /// An idle guest blocks until an interrupt or a cross-thread kick arrives.
    pub fn run(&mut self) -> Result<VcpuExit<'_>> {
        match self.fd.run().map(|_| ()) {
            Ok(()) => {}
            Err(error) if error.errno() == libc::EINTR => {
                self.kick.drain().map_err(|source| Error::RunVcpu {
                    id: self.id,
                    source,
                })?;
                self.pending_io.0 = false;
                return Ok(VcpuExit::Interrupted);
            }
            Err(error) => {
                return Err(Error::RunVcpu {
                    id: self.id,
                    source: error.into(),
                });
            }
        }
        // Reborrow after rust-vmm's exit: its port variants omit the count that
        // distinguishes a single access from a repeated string transfer.
        let run = self.fd.get_kvm_run();
        self.pending_io.0 = matches!(run.exit_reason, KVM_EXIT_IO | KVM_EXIT_MMIO);
        // SAFETY: the descriptor owns the complete run_size mapping, KVM_RUN
        // has returned, and &mut self excludes both re-entry and other users.
        unsafe { decode_exit(self.id, run, self.run_size) }
    }

    /// Finishes handled I/O without executing another guest instruction.
    /// A second completion is a no-op; failures retain the pending access.
    pub fn complete_pending_io(&mut self) -> Result<()> {
        self.pending_io
            .complete(|| {
                self.fd.set_kvm_immediate_exit(1);
                let result = self.fd.run().map(|_| ()).map_err(io::Error::from);
                self.fd.set_kvm_immediate_exit(0);
                result
            })
            .map_err(|source| Error::CompletePendingIo {
                id: self.id,
                source,
            })
    }
}

#[derive(Debug, Default)]
struct PendingIo(bool);

impl PendingIo {
    fn complete(&mut self, enter: impl FnOnce() -> io::Result<()>) -> io::Result<()> {
        if !self.0 {
            return Ok(());
        }
        match enter() {
            Err(error) if error.raw_os_error() == Some(libc::EINTR) => {
                self.0 = false;
                Ok(())
            }
            Err(error) => Err(error),
            Ok(()) => Err(io::Error::other(
                "KVM_RUN returned an exit during I/O completion",
            )),
        }
    }
}

// SAFETY: run must begin a live, exclusively borrowed mapping of run_size bytes.
// No vCPU may enter KVM while the returned exit borrows that mapping.
unsafe fn decode_exit(id: u32, run: &mut kvm_run, run_size: usize) -> Result<VcpuExit<'_>> {
    let reason = run.exit_reason;
    let unsupported = || Error::UnhandledExit {
        id,
        reason: format!("KVM exit {reason} has an unsupported reason or I/O shape"),
    };
    match reason {
        KVM_EXIT_IO => {
            // SAFETY: exit_reason identifies the active union field.
            let access = unsafe { run.__bindgen_anon_1.io };
            let offset = usize::try_from(access.data_offset).map_err(|_| unsupported())?;
            let size = usize::from(access.size);
            if access.count != 1
                || !matches!(size, 1 | 2 | 4)
                || offset < size_of::<kvm_run>()
                || offset.checked_add(size).is_none_or(|end| end > run_size)
                || !matches!(
                    u32::from(access.direction),
                    KVM_EXIT_IO_IN | KVM_EXIT_IO_OUT
                )
            {
                return Err(unsupported());
            }
            // SAFETY: the caller supplies the entire mapping; the checked range
            // lies beyond the header and inside it. The exit retains its borrow.
            let bytes = unsafe {
                std::slice::from_raw_parts_mut((run as *mut kvm_run).cast::<u8>().add(offset), size)
            };
            Ok(if u32::from(access.direction) == KVM_EXIT_IO_IN {
                VcpuExit::IoIn {
                    port: access.port,
                    bytes,
                }
            } else {
                VcpuExit::IoOut {
                    port: access.port,
                    bytes,
                }
            })
        }
        KVM_EXIT_MMIO => {
            // SAFETY: exit_reason identifies the active union field.
            let access = unsafe { &mut run.__bindgen_anon_1.mmio };
            if !matches!(access.len, 1 | 2 | 4 | 8) || access.is_write > 1 {
                return Err(unsupported());
            }
            let bytes = &mut access.data[..access.len as usize];
            Ok(if access.is_write == 0 {
                VcpuExit::MmioRead {
                    guest_addr: access.phys_addr,
                    bytes,
                }
            } else {
                VcpuExit::MmioWrite {
                    guest_addr: access.phys_addr,
                    bytes,
                }
            })
        }
        KVM_EXIT_INTR => Ok(VcpuExit::Interrupted),
        KVM_EXIT_HLT => Ok(VcpuExit::Halted),
        KVM_EXIT_SHUTDOWN => Ok(VcpuExit::Reset), // x86 triple fault.
        KVM_EXIT_SYSTEM_EVENT => {
            // SAFETY: exit_reason identifies the active union field.
            match unsafe { run.__bindgen_anon_1.system_event.type_ } {
                KVM_SYSTEM_EVENT_SHUTDOWN => Ok(VcpuExit::Shutdown),
                KVM_SYSTEM_EVENT_RESET => Ok(VcpuExit::Reset),
                _ => Err(unsupported()),
            }
        }
        _ => Err(unsupported()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[repr(C)]
    #[derive(Default)]
    struct ExitBuffer {
        run: kvm_run,
        port_bytes: [u8; 8],
    }

    impl ExitBuffer {
        fn decode(&mut self) -> Result<VcpuExit<'_>> {
            // SAFETY: run is the first field of this exclusive allocation.
            unsafe { decode_exit(7, &mut self.run, size_of::<Self>()) }
        }
    }

    #[test]
    fn port_exits_preserve_width_and_borrow_the_response_buffer() {
        let mut buffer = ExitBuffer::default();
        buffer.run.exit_reason = KVM_EXIT_IO;
        for size in [1, 2, 4] {
            buffer.run.__bindgen_anon_1.io = kvm_bindings::kvm_run__bindgen_ty_1__bindgen_ty_4 {
                direction: KVM_EXIT_IO_IN as u8,
                size,
                port: 0x3f8,
                count: 1,
                data_offset: std::mem::offset_of!(ExitBuffer, port_bytes) as u64,
            };
            let VcpuExit::IoIn { port, bytes } = buffer.decode().unwrap() else {
                panic!("expected input")
            };
            assert_eq!(port, 0x3f8);
            assert_eq!(bytes.len(), usize::from(size));
            bytes.fill(0x5a);
            buffer.run.__bindgen_anon_1.io.direction = KVM_EXIT_IO_OUT as u8;
            let VcpuExit::IoOut { port, bytes } = buffer.decode().unwrap() else {
                panic!("expected output")
            };
            assert_eq!(port, 0x3f8);
            assert_eq!(bytes, vec![0x5a; usize::from(size)]);
        }
        for (count, size, direction, offset) in [
            (2, 1, 0, size_of::<kvm_run>() as u64),
            (0, 1, 0, size_of::<kvm_run>() as u64),
            (1, 3, 0, size_of::<kvm_run>() as u64),
            (1, 1, 2, size_of::<kvm_run>() as u64),
            (1, 1, 0, 0),
            (1, 4, 0, u64::MAX),
            (1, 4, 0, (size_of::<ExitBuffer>() - 1) as u64),
        ] {
            buffer.run.__bindgen_anon_1.io = kvm_bindings::kvm_run__bindgen_ty_1__bindgen_ty_4 {
                direction,
                size,
                port: 0x3f8,
                count,
                data_offset: offset,
            };
            assert!(matches!(
                buffer.decode(),
                Err(Error::UnhandledExit { id: 7, .. })
            ));
        }
    }

    #[test]
    fn mmio_exits_preserve_address_width_and_read_responses() {
        let mut buffer = ExitBuffer::default();
        buffer.run.exit_reason = KVM_EXIT_MMIO;
        for len in [1, 2, 4, 8] {
            buffer.run.__bindgen_anon_1.mmio = kvm_bindings::kvm_run__bindgen_ty_1__bindgen_ty_6 {
                phys_addr: 0x1000_0000,
                data: [0; 8],
                len,
                is_write: 0,
            };
            let VcpuExit::MmioRead { guest_addr, bytes } = buffer.decode().unwrap() else {
                panic!("expected read")
            };
            assert_eq!(guest_addr, 0x1000_0000);
            assert_eq!(bytes.len(), len as usize);
            bytes.fill(0x42);
            buffer.run.__bindgen_anon_1.mmio.is_write = 1;
            let VcpuExit::MmioWrite { guest_addr, bytes } = buffer.decode().unwrap() else {
                panic!("expected write")
            };
            assert_eq!(guest_addr, 0x1000_0000);
            assert_eq!(bytes, vec![0x42; len as usize]);
        }
        for (len, is_write) in [(0, 0), (3, 0), (9, 0), (1, 2)] {
            buffer.run.__bindgen_anon_1.mmio.len = len;
            buffer.run.__bindgen_anon_1.mmio.is_write = is_write;
            assert!(buffer.decode().is_err());
        }
    }

    #[test]
    fn control_exits_distinguish_reset_shutdown_and_unsupported_events() {
        let mut buffer = ExitBuffer::default();
        for (reason, event, expected) in [
            (KVM_EXIT_INTR, 0, VcpuExit::Interrupted),
            (KVM_EXIT_HLT, 0, VcpuExit::Halted),
            (KVM_EXIT_SHUTDOWN, 0, VcpuExit::Reset),
            (
                KVM_EXIT_SYSTEM_EVENT,
                KVM_SYSTEM_EVENT_RESET,
                VcpuExit::Reset,
            ),
            (
                KVM_EXIT_SYSTEM_EVENT,
                KVM_SYSTEM_EVENT_SHUTDOWN,
                VcpuExit::Shutdown,
            ),
        ] {
            buffer.run.exit_reason = reason;
            buffer.run.__bindgen_anon_1.system_event.type_ = event;
            assert_eq!(
                std::mem::discriminant(&buffer.decode().unwrap()),
                std::mem::discriminant(&expected)
            );
        }
        for reason in [KVM_EXIT_SYSTEM_EVENT, u32::MAX] {
            buffer.run.exit_reason = reason;
            buffer.run.__bindgen_anon_1.system_event.type_ = u32::MAX;
            assert!(matches!(
                buffer.decode(),
                Err(Error::UnhandledExit { id: 7, .. })
            ));
        }
    }

    #[test]
    fn completion_consumes_pending_io_only_after_interrupted_reentry() {
        let mut pending = PendingIo::default();
        pending.complete(|| panic!("no pending I/O")).unwrap();
        pending.0 = true;
        let error = pending
            .complete(|| Err(io::Error::from_raw_os_error(libc::EIO)))
            .unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::EIO));
        assert!(pending.0);
        assert!(pending.complete(|| Ok(())).is_err());
        assert!(pending.0);
        pending
            .complete(|| Err(io::Error::from_raw_os_error(libc::EINTR)))
            .unwrap();
        assert!(!pending.0);
        pending.complete(|| panic!("must not enter twice")).unwrap();
    }
}
