// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! One monotonic timer wakes the existing worker to expire undecided host sockets.

use crate::virtio::{DeviceError, EventRegistrar, EventSource, SourceId};
use mio::{Interest, Registry, Token, event::Source, unix::SourceFd};
use std::{
    io,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    sync::Arc,
    time::{Duration, Instant},
};

struct TimerSource(Arc<OwnedFd>);

impl EventSource for TimerSource {
    fn as_source(&mut self) -> &mut dyn Source {
        self
    }
}

impl Source for TimerSource {
    fn register(&mut self, registry: &Registry, token: Token, _: Interest) -> io::Result<()> {
        SourceFd(&self.0.as_raw_fd()).register(registry, token, Interest::READABLE)
    }

    fn reregister(&mut self, registry: &Registry, token: Token, _: Interest) -> io::Result<()> {
        SourceFd(&self.0.as_raw_fd()).reregister(registry, token, Interest::READABLE)
    }

    fn deregister(&mut self, registry: &Registry) -> io::Result<()> {
        SourceFd(&self.0.as_raw_fd()).deregister(registry)
    }
}

pub(super) struct SelectionTimer {
    registrar: Arc<dyn EventRegistrar>,
    id: SourceId,
    fd: Arc<OwnedFd>,
    deadline: Option<Instant>,
}

impl SelectionTimer {
    pub fn new(registrar: Arc<dyn EventRegistrar>) -> Result<Self, DeviceError> {
        // SAFETY: timerfd_create has no pointer arguments; ownership is taken only on success.
        let fd = unsafe {
            libc::timerfd_create(
                libc::CLOCK_MONOTONIC,
                libc::TFD_CLOEXEC | libc::TFD_NONBLOCK,
            )
        };
        if fd < 0 {
            return Err(DeviceError::Fatal("vsock selection timer creation"));
        }
        // SAFETY: the successful syscall returned a new descriptor owned by this instance.
        let fd = Arc::new(unsafe { OwnedFd::from_raw_fd(fd) });
        let id = registrar
            .register(Box::new(TimerSource(Arc::clone(&fd))))
            .map_err(|_| DeviceError::Fatal("vsock selection timer registration"))?;
        Ok(Self {
            registrar,
            id,
            fd,
            deadline: None,
        })
    }

    pub fn arm(&mut self, deadline: Option<Instant>) -> Result<(), DeviceError> {
        if self.deadline == deadline {
            return Ok(());
        }
        let delay = deadline.map(|end| {
            end.saturating_duration_since(Instant::now())
                .max(Duration::from_nanos(1))
        });
        let spec = libc::itimerspec {
            it_interval: libc::timespec {
                tv_sec: 0,
                tv_nsec: 0,
            },
            it_value: libc::timespec {
                tv_sec: delay.map_or(0, |value| value.as_secs() as libc::time_t),
                tv_nsec: delay.map_or(0, |value| value.subsec_nanos() as libc::c_long),
            },
        };
        // Rearming also clears unread expirations, so a retired selection cannot leave
        // the worker spinning on timer readiness.
        // SAFETY: fd is a live timer and spec remains initialized through the call.
        if unsafe { libc::timerfd_settime(self.fd.as_raw_fd(), 0, &spec, std::ptr::null_mut()) } < 0
        {
            return Err(DeviceError::Fatal("vsock selection timer arming"));
        }
        self.deadline = deadline;
        Ok(())
    }
}

impl Drop for SelectionTimer {
    fn drop(&mut self) {
        self.registrar.deregister(self.id);
    }
}
