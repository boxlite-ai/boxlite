// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{
    io,
    os::fd::RawFd,
    sync::{Arc, Mutex},
};

use crate::{Error, Result, VcpuHandle};

#[derive(Debug)]
struct Target {
    thread: Option<libc::pthread_t>,
    pending: bool,
}

/// A cross-thread kick handle that becomes inert when its vCPU is dropped.
#[derive(Clone, Debug)]
pub struct KvmVcpuHandle {
    id: u32,
    signal: i32,
    target: Arc<Mutex<Target>>,
}

impl VcpuHandle for KvmVcpuHandle {
    fn kick(&self) -> Result<()> {
        let send = || {
            let mut target = self
                .target
                .lock()
                .map_err(|_| io::Error::other("KVM kick lock is poisoned"))?;
            if let Some(thread) = target.thread.filter(|_| !target.pending) {
                // SAFETY: drop takes this lock before invalidating the owning
                // thread. The reserved signal stays blocked outside KVM_RUN.
                let status = unsafe { libc::pthread_kill(thread, self.signal) };
                if status != 0 {
                    return Err(io::Error::from_raw_os_error(status));
                }
                target.pending = true;
            }
            Ok(())
        };
        send().map_err(|source| Error::KickVcpu {
            id: self.id,
            source,
        })
    }
}

pub(super) struct WorkerSignal {
    handle: KvmVcpuHandle,
    blocked: libc::sigset_t,
}

impl std::fmt::Debug for WorkerSignal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WorkerSignal")
            .field("handle", &self.handle)
            .finish()
    }
}

impl WorkerSignal {
    pub(super) fn new(id: u32, signal: i32, fd: RawFd) -> io::Result<Self> {
        let (owner, original) = Self::reserve(id, signal)?;
        // KVM's flexible-array ABI puts the eight-byte kernel signal set
        // immediately after len, without u64 alignment or libc's padding.
        #[repr(C)]
        struct RunMask {
            len: u32,
            bits: [u8; 8],
        }
        let mut mask = RunMask {
            len: 8,
            bits: [0; 8],
        };
        // SAFETY: Linux sigset_t begins with the kernel's 64 signal bits.
        unsafe {
            std::ptr::copy_nonoverlapping(
                (&original as *const libc::sigset_t).cast(),
                mask.bits.as_mut_ptr(),
                8,
            )
        };
        // KVM_SET_SIGNAL_MASK = _IOW(0xae, 0x8b, struct kvm_signal_mask).
        // SAFETY: fd is borrowed for this ioctl; mask includes its flexible data.
        if unsafe { libc::ioctl(fd, 0x4004_ae8b as libc::c_ulong, &mask) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(owner)
    }

    fn reserve(id: u32, signal: i32) -> io::Result<(Self, libc::sigset_t)> {
        if !(libc::SIGRTMIN()..=libc::SIGRTMAX()).contains(&signal) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "KVM kick signal must be a realtime signal",
            ));
        }
        // SAFETY: these C structs permit zero initialization and each pointer
        // refers to a live, correctly sized local object.
        let (mut action, mut blocked, mut original) = unsafe {
            (
                std::mem::zeroed::<libc::sigaction>(),
                std::mem::zeroed::<libc::sigset_t>(),
                std::mem::zeroed::<libc::sigset_t>(),
            )
        };
        // SAFETY: query only; this never replaces the application's handler.
        if unsafe { libc::sigaction(signal, std::ptr::null(), &mut action) } < 0 {
            return Err(io::Error::last_os_error());
        }
        if action.sa_sigaction != libc::SIG_DFL {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "KVM kick signal already has a disposition",
            ));
        }
        // SAFETY: blocked is initialized before use; signal is in the valid range.
        unsafe {
            libc::sigemptyset(&mut blocked);
            libc::sigaddset(&mut blocked, signal);
        }
        // SAFETY: only the calling worker's signal mask changes.
        let status = unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, &blocked, &mut original) };
        if status != 0 {
            return Err(io::Error::from_raw_os_error(status));
        }
        // SAFETY: original was filled by pthread_sigmask.
        if unsafe { libc::sigismember(&original, signal) } == 1 {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "KVM kick signal is already blocked on this worker",
            ));
        }
        Ok((
            Self {
                handle: KvmVcpuHandle {
                    id,
                    signal,
                    target: Arc::new(Mutex::new(Target {
                        // SAFETY: the worker remains alive through its vCPU's drop.
                        thread: Some(unsafe { libc::pthread_self() }),
                        pending: false,
                    })),
                },
                blocked,
            },
            original,
        ))
    }

    pub(super) fn handle(&self) -> KvmVcpuHandle {
        self.handle.clone()
    }

    pub(super) fn drain(&self) -> io::Result<()> {
        let mut target = self
            .handle
            .target
            .lock()
            .map_err(|_| io::Error::other("KVM kick lock is poisoned"))?;
        self.drain_signal()?;
        target.pending = false;
        Ok(())
    }

    fn drain_signal(&self) -> io::Result<()> {
        let timeout = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        loop {
            // SAFETY: the signal remains blocked, and timeout is valid. A zero
            // timeout consumes pending signals without waiting for another kick.
            if unsafe { libc::sigtimedwait(&self.blocked, std::ptr::null_mut(), &timeout) } >= 0 {
                continue;
            }
            let error = io::Error::last_os_error();
            match error.raw_os_error() {
                Some(libc::EAGAIN) => return Ok(()),
                Some(libc::EINTR) => continue,
                _ => return Err(error),
            }
        }
    }
}

impl Drop for WorkerSignal {
    fn drop(&mut self) {
        let mut target = self
            .handle
            .target
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        target.thread = None;
        // Keep a failed drain blocked rather than deliver a fatal default signal.
        if let Err(error) = self.drain_signal() {
            eprintln!(
                "failed to drain KVM vCPU {} kick signal: {error}",
                self.handle.id
            );
            return;
        }
        // SAFETY: reservation established that this signal was originally unblocked.
        // Restore only that bit, preserving unrelated changes to the thread mask.
        let status = unsafe {
            libc::pthread_sigmask(libc::SIG_UNBLOCK, &self.blocked, std::ptr::null_mut())
        };
        if status != 0 {
            eprintln!(
                "failed to restore KVM vCPU {} signal mask: {}",
                self.handle.id,
                io::Error::from_raw_os_error(status)
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{os::fd::AsRawFd, sync::mpsc, thread};

    fn blocked(signal: i32) -> bool {
        // SAFETY: query an initialized signal set for the current thread.
        unsafe {
            let mut mask = std::mem::zeroed();
            assert_eq!(
                libc::pthread_sigmask(libc::SIG_BLOCK, std::ptr::null(), &mut mask),
                0
            );
            libc::sigismember(&mask, signal) == 1
        }
    }

    #[test]
    fn worker_signals_coalesce_drain_restore_and_ignore_stale_handles() {
        let (handles, receive_handle) = mpsc::sync_channel(1);
        let (resume, receive_resume) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            let signal = libc::SIGRTMIN() + 1;
            assert!(!blocked(signal));
            let (owner, _) = WorkerSignal::reserve(7, signal).unwrap();
            assert!(blocked(signal));
            assert!(WorkerSignal::reserve(8, signal).is_err());
            handles.send(owner.handle()).unwrap();
            receive_resume.recv().unwrap();
            assert!(owner.handle.target.lock().unwrap().pending);
            owner.drain().unwrap();
            assert!(!owner.handle.target.lock().unwrap().pending);
            owner.handle().kick().unwrap();
            drop(owner);
            assert!(!blocked(signal));
        });
        let handle = receive_handle.recv().unwrap();
        handle.kick().unwrap();
        handle.kick().unwrap();
        resume.send(()).unwrap();
        worker.join().unwrap();
        handle.kick().unwrap();
    }

    #[test]
    fn failed_kvm_configuration_restores_the_worker_mask() {
        thread::spawn(|| {
            let signal = libc::SIGRTMIN() + 1;
            let file = std::fs::File::open("/dev/null").unwrap();
            let error = WorkerSignal::new(3, signal, file.as_raw_fd()).unwrap_err();
            assert_eq!(error.raw_os_error(), Some(libc::ENOTTY));
            assert!(!blocked(signal));
            for invalid in [0, libc::SIGKILL, libc::SIGRTMAX() + 1] {
                assert_eq!(
                    WorkerSignal::reserve(3, invalid).unwrap_err().kind(),
                    io::ErrorKind::InvalidInput
                );
            }
        })
        .join()
        .unwrap();
    }
}
