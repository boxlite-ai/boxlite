// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use super::*;

fn pending_handshake_close(payload: &[u8]) {
    let temp = Temp::new();
    let path = temp.path("pending");
    let listener = UnixListener::bind(&path).unwrap();
    let mut h = TransportHarness::new(vec![PortMapping::Listen {
        port: 2695,
        listener,
    }]);
    h.activate();
    let mut host = UnixStream::connect(&path).unwrap();
    bounded(&host);
    let request = h.next(REQUEST);
    {
        let _device = h.device.lock().unwrap();
        host.write_all(payload).unwrap();
        drop(host);
    }
    let reset = h.next(RST);
    assert_eq!(reset.header.src_port, request.header.src_port);
    assert_eq!(reset.header.dst_port, request.header.dst_port);
    assert!(
        h.packets.is_empty(),
        "handshake data must not reach the guest"
    );
    assert!(h.events.wait(Some(Duration::ZERO)).unwrap().is_none());
}

#[test]
fn production_worker_reclaims_pending_handshake_after_empty_host_close() {
    pending_handshake_close(b"");
}

#[test]
fn production_worker_reclaims_pending_handshake_after_buffered_host_close() {
    pending_handshake_close(b"unread handshake payload");
}

#[test]
fn production_worker_resumes_accept_after_pending_handshake_close() {
    let temp = Temp::new();
    let path = temp.path("capacity");
    let listener = UnixListener::bind(&path).unwrap();
    let mut h = TransportHarness::new(vec![PortMapping::Listen {
        port: 2695,
        listener,
    }]);
    h.activate();
    let mut hosts = Vec::new();
    let mut last_port = 0;
    for _ in 0..backend::MAX_CONNECTIONS {
        hosts.push(UnixStream::connect(&path).unwrap());
        last_port = h.next(REQUEST).header.src_port;
    }
    let _queued_host = UnixStream::connect(&path).unwrap();
    drop(hosts.pop().unwrap());

    // Enough RX heads remain for both controls. Do not refill or kick: closure
    // must resume the listener even if its readiness arrived at full capacity.
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    let mut controls = Vec::new();
    while controls.len() < 2 {
        controls.extend(h.rx.take(&h.memory).into_iter().map(|bytes| {
            let header = Packet::read(&mut bytes.as_slice()).unwrap().header;
            (header.op, header.src_port)
        }));
        if controls.len() < 2 {
            h.irq
                .recv_timeout(deadline.saturating_duration_since(std::time::Instant::now()))
                .expect("closed handshake did not release a slot and resume accepts");
        }
    }
    assert_eq!(controls, [(RST, last_port), (REQUEST, last_port + 1)]);
}

#[test]
fn private_notifications_coalesce_reuse_registration_and_tolerate_spurious_readiness() {
    let registrar = Arc::new(Registrar::new());
    let mut notification = Reschedule::new(registrar.clone()).unwrap();
    for _ in 0..4 {
        for _ in 0..3 {
            notification.schedule().unwrap();
        }
        let ready = registrar.ready();
        assert_eq!(ready.len(), 1);
        assert!(!notification.acknowledge(DeviceEvent::QueueKick(0)).unwrap());
        assert!(notification.acknowledge(ready[0]).unwrap());
        // A stale readiness report still belongs to us, but has no byte to consume.
        assert!(notification.acknowledge(ready[0]).unwrap());
        assert!(registrar.ready().is_empty());
        assert_eq!(registrar.len(), 1);
        assert_eq!(registrar.next.load(Ordering::Relaxed), 1);
    }
    drop(notification);
    assert_eq!(registrar.len(), 0);
}

struct ObservedVsock {
    inner: Vsock,
    id: u8,
    callbacks: std::sync::mpsc::Sender<u8>,
}

impl VirtioDevice for ObservedVsock {
    fn spec(&self) -> &DeviceSpec {
        self.inner.spec()
    }
    fn set_features(&mut self, features: u64) -> Result<(), FeatureError> {
        self.inner.set_features(features)
    }
    fn read_config(&mut self, offset: u64, data: &mut [u8]) -> Result<(), DeviceError> {
        self.inner.read_config(offset, data)
    }
    fn write_config(&mut self, offset: u64, data: &[u8]) -> Result<(), DeviceError> {
        self.inner.write_config(offset, data)
    }
    fn activate(&mut self, ctx: ActivationContext) -> Result<(), DeviceError> {
        self.inner.activate(ctx)
    }
    fn reset(&mut self) -> Result<(), DeviceError> {
        self.inner.reset()
    }
    fn on_event(&mut self, event: DeviceEvent) -> Result<(), DeviceError> {
        self.inner.on_event(event)?;
        self.callbacks.send(self.id).unwrap();
        Ok(())
    }
}

#[test]
fn private_notifications_yield_to_another_device_on_the_original_worker() {
    let temp = Temp::new();
    let runtime = TransportHarness::new(vec![]);
    let (send, receive) = std::sync::mpsc::channel();
    let mut devices = Vec::new();
    let mut controls = Vec::new();
    for id in 0..2 {
        let mappings = if id == 0 {
            (0..257)
                .map(|port| PortMapping::Listen {
                    port,
                    listener: UnixListener::bind(temp.path(&port.to_string())).unwrap(),
                })
                .collect()
        } else {
            vec![]
        };
        let device = Arc::new(Mutex::new(ObservedVsock {
            inner: Vsock::new(3, mappings).unwrap(),
            id,
            callbacks: send.clone(),
        }));
        let mut input = Harness::new(vec![]);
        input.device.reset().unwrap();
        let control = runtime.workers.add(device.clone(), input.interrupt.clone());
        let prepared = control.prepare().unwrap();
        let mut ctx = input.context();
        ctx.events = prepared.events;
        ctx.waker = prepared.waker;
        device.lock().unwrap().set_features(0).unwrap();
        device.lock().unwrap().activate(ctx).unwrap();
        devices.push(device);
        controls.push(control);
    }
    // Both private notifications exist before polling. Hold the first device
    // until both slots run, so scheduling order does not depend on thread timing.
    let guard = devices[0].lock().unwrap();
    controls[0].start().unwrap();
    controls[1].start().unwrap();
    drop(guard);
    let observed: Vec<_> = (0..3)
        .map(|_| receive.recv_timeout(Duration::from_secs(3)).unwrap())
        .collect();
    assert_eq!(
        observed,
        [0, 1, 0],
        "budget continuation must let the other device run"
    );
    for (control, device) in controls.iter().zip(&devices) {
        control.stop().unwrap();
        device.lock().unwrap().reset().unwrap();
    }
    assert!(
        receive.try_recv().is_err(),
        "empty listener sweeps must stop"
    );
}
