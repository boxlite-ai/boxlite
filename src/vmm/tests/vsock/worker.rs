// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Test-only poller driving vsock through the existing MMIO worker contract.

use crate::virtio::{
    DeviceError, DeviceEvent, EventError, EventRegistrar, EventSource, SourceId, VirtioDevice,
    VirtioInterrupt, WorkerContext, WorkerControl, mmio::MmioResources,
};
use crate::{
    error::Error,
    events::{Event, EventSender},
    memory::GuestMemoryMmap,
};
use mio::{Events, Interest, Poll, Registry, Token};
use std::{
    collections::BTreeMap,
    io,
    panic::{AssertUnwindSafe, catch_unwind},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32, Ordering},
    },
    thread,
};

// Device status bits from VIRTIO 1.2 §2.1.
const DRIVER_OK: u8 = 4;
const NEEDS_RESET: u8 = 64;
const FAILED: u8 = 128;

type Sources = BTreeMap<u32, (DeviceEvent, Box<dyn EventSource>)>;
struct Registrar {
    registry: Registry,
    sources: Mutex<Sources>,
    next: AtomicU32,
    closed: AtomicBool,
}

impl EventRegistrar for Registrar {
    fn register(&self, mut source: Box<dyn EventSource>) -> Result<SourceId, EventError> {
        let mut sources = self.sources.lock().unwrap();
        if self.closed.load(Ordering::Acquire) {
            return Err(EventError::Closed);
        }
        let id = self.next.load(Ordering::Relaxed);
        let next = id.checked_add(1).ok_or(EventError::Closed)?;
        self.next.store(next, Ordering::Relaxed);
        source
            .as_source()
            .register(
                &self.registry,
                Token(id as usize),
                Interest::READABLE | Interest::WRITABLE,
            )
            .map_err(|error| {
                tracing::error!(%error, "device source registration failed");
                EventError::Closed
            })?;
        sources.insert(id, (DeviceEvent::BackendReady(SourceId(id)), source));
        Ok(SourceId(id))
    }
    fn deregister(&self, id: SourceId) {
        if let Some((_, mut source)) = self.sources.lock().unwrap().remove(&id.0)
            && let Err(error) = source.as_source().deregister(&self.registry)
        {
            tracing::warn!(%error, "device source deregistration failed");
        }
    }
}

impl Registrar {
    fn close(&self) {
        let mut sources = self.sources.lock().unwrap();
        self.closed.store(true, Ordering::Release);
        for (_, (_, mut source)) in std::mem::take(&mut *sources) {
            source.as_source().deregister(&self.registry).unwrap();
        }
    }
}

#[derive(Clone)]
struct WorkerHandle {
    wake: Arc<mio::Waker>,
    continuation: Arc<AtomicBool>,
}
impl WorkerHandle {
    fn waker(&self) -> crate::virtio::Waker {
        let this = self.clone();
        Arc::new(move || {
            this.continuation.store(true, Ordering::Release);
            this.wake();
        })
    }
    fn wake(&self) {
        if let Err(error) = self.wake.wake() {
            tracing::error!(%error, "device wake failed");
        }
    }
}

struct Runtime {
    poll: Option<Poll>,
    thread: Option<thread::JoinHandle<Poll>>,
}

pub(super) struct TestWorker {
    handle: WorkerHandle,
    registrar: Mutex<Arc<Registrar>>,
    runtime: Mutex<Runtime>,
    stop: Arc<AtomicBool>,
    device: Arc<Mutex<dyn VirtioDevice>>,
    interrupt: Arc<dyn VirtioInterrupt>,
    sender: EventSender,
}

impl TestWorker {
    pub(super) fn new(
        device: Arc<Mutex<dyn VirtioDevice>>,
        interrupt: Arc<dyn VirtioInterrupt>,
        sender: EventSender,
    ) -> io::Result<Arc<Self>> {
        let poll = Poll::new()?;
        let wake = Arc::new(mio::Waker::new(poll.registry(), Token(0))?);
        let registrar = Arc::new(Registrar {
            registry: poll.registry().try_clone()?,
            sources: Mutex::new(BTreeMap::new()),
            next: AtomicU32::new(1),
            closed: AtomicBool::new(false),
        });
        Ok(Arc::new(Self {
            handle: WorkerHandle {
                wake,
                continuation: Arc::new(AtomicBool::new(false)),
            },
            registrar: Mutex::new(registrar),
            runtime: Mutex::new(Runtime {
                poll: Some(poll),
                thread: None,
            }),
            stop: Arc::new(AtomicBool::new(false)),
            device,
            interrupt,
            sender,
        }))
    }

    pub(super) fn resources(self: &Arc<Self>, memory: Arc<GuestMemoryMmap>) -> MmioResources {
        MmioResources {
            memory,
            sender: self.sender.clone(),
            worker: self.clone(),
        }
    }

    /// Stop callbacks and release the device resources at the end of the test.
    pub(super) fn shutdown(&self) {
        if let Err(error) = self.stop() {
            tracing::warn!(%error, "device stop during shutdown failed");
            return;
        }
        let mut device = self
            .device
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Err(error) = device.reset() {
            tracing::warn!(%error, "device reset during shutdown failed");
        }
    }
}

impl WorkerControl for TestWorker {
    fn prepare(&self) -> Result<WorkerContext, DeviceError> {
        let mut current = self.registrar.lock().unwrap();
        current.close();
        let registrar = Arc::new(Registrar {
            registry: current
                .registry
                .try_clone()
                .map_err(|_| DeviceError::Fatal("test registry clone"))?,
            sources: Mutex::new(BTreeMap::new()),
            next: AtomicU32::new(current.next.load(Ordering::Relaxed)),
            closed: AtomicBool::new(false),
        });
        *current = registrar.clone();
        let wake = self.handle.waker();
        let generation = registrar.clone();
        Ok(WorkerContext {
            events: registrar,
            waker: Arc::new(move || {
                if !generation.closed.load(Ordering::Acquire) {
                    wake();
                }
            }),
        })
    }

    fn kick(&self, _index: u16) {
        (self.handle.waker())();
    }

    fn cancel_prepare(&self) {
        self.registrar.lock().unwrap().close();
    }

    fn start(&self) -> Result<(), DeviceError> {
        let mut runtime = self.runtime.lock().unwrap();
        if runtime.thread.is_some() {
            return Ok(());
        }
        if self
            .registrar
            .lock()
            .unwrap()
            .closed
            .load(Ordering::Acquire)
        {
            return Err(DeviceError::Fatal("device worker is closed"));
        }
        let Some(mut poll) = runtime.poll.take() else {
            return Err(DeviceError::Fatal("device poller unavailable"));
        };
        self.stop.store(false, Ordering::Release);
        // Neither the thread nor the device's waker owns Arc<TestWorker>.
        let (handle, stop, device, interrupt, sender, registrar) = (
            self.handle.clone(),
            self.stop.clone(),
            self.device.clone(),
            self.interrupt.clone(),
            self.sender.clone(),
            self.registrar.lock().unwrap().clone(),
        );
        runtime.thread = Some(
            thread::Builder::new()
                .name("virtio".into())
                .spawn(move || {
                    let result = catch_unwind(AssertUnwindSafe(|| -> io::Result<()> {
                        let mut readiness = Events::with_capacity(256);
                        while !stop.load(Ordering::Acquire) {
                            match poll.poll(&mut readiness, Some(std::time::Duration::from_secs(1)))
                            {
                                Err(error) if error.kind() == io::ErrorKind::Interrupted => {
                                    continue;
                                }
                                result => result?,
                            }
                            if stop.load(Ordering::Acquire) {
                                break;
                            }
                            let mut events: Vec<_> = {
                                let sources = registrar.sources.lock().unwrap();
                                readiness
                                    .iter()
                                    .filter_map(|e| sources.get(&(e.token().0 as u32)).map(|s| s.0))
                                    .collect()
                            };
                            if handle.continuation.swap(false, Ordering::AcqRel) {
                                // Vsock services every queue on a kick, as in the
                                // manually driven harness.
                                events.push(DeviceEvent::QueueKick(0));
                            }
                            for event in events {
                                let mut device = device.lock().unwrap();
                                let status = interrupt.device_status();
                                if stop.load(Ordering::Acquire)
                                    || status & DRIVER_OK == 0
                                    || status & (NEEDS_RESET | FAILED) != 0
                                {
                                    break;
                                }
                                if let Err(error) = device.on_event(event) {
                                    match error {
                                        DeviceError::NeedsReset(_)
                                        | DeviceError::Unsupported(_) => {
                                            interrupt.set_needs_reset();
                                            interrupt.raise_config();
                                        }
                                        DeviceError::Fatal(_) => {
                                            return Err(io::Error::other(error));
                                        }
                                    }
                                    break;
                                }
                            }
                        }
                        Ok(())
                    }));
                    if let Err(source) =
                        result.unwrap_or_else(|_| Err(io::Error::other("device worker panicked")))
                    {
                        tracing::error!(%source, "test worker failed");
                        sender.send(Event::DeviceFailed(Error::VirtioDevice {
                            device: "vsock",
                            reason: "test worker failed",
                        }));
                    }
                    poll
                })
                .map_err(|error| {
                    tracing::error!(%error, "device thread spawn failed");
                    DeviceError::Fatal("device thread spawn")
                })?,
        );
        (self.handle.waker())();
        Ok(())
    }

    fn stop(&self) -> Result<(), DeviceError> {
        let mut runtime = self
            .runtime
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        self.stop.store(true, Ordering::Release);
        self.handle.wake();
        if let Some(thread) = runtime.thread.take() {
            runtime.poll = Some(
                thread
                    .join()
                    .map_err(|_| DeviceError::Fatal("device worker join"))?,
            );
        }
        self.handle.continuation.store(false, Ordering::Release);
        self.cancel_prepare();
        Ok(())
    }
}

impl Drop for TestWorker {
    fn drop(&mut self) {
        if let Err(error) = self.stop() {
            tracing::warn!(%error, "device worker drop failed");
        }
    }
}
