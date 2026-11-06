// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Real worker dispatch, including continuation without further peer writes.

use super::*;
use crate::virtio::worker::VirtioWorkers;

struct RunningWorkers(VirtioWorkers);
impl Drop for RunningWorkers {
    fn drop(&mut self) {
        let _ = self.0.shutdown();
    }
}

#[test]
fn shared_runtime_transfers_packets_and_continues_after_the_io_budget() {
    let mut h = Harness::new(MACS[0]);
    h.queue_size = 256;
    let listener = UnixListener::bind(&h.path.0).unwrap();
    let net = Arc::new(Mutex::new(Net::new(h.path.0.clone(), MACS[0])));
    let workers = RunningWorkers(VirtioWorkers::new(h._event_loop.sender()).unwrap());
    let control = workers.0.add(net.clone(), h.interrupt.clone());
    let prepared = control.prepare().unwrap();
    let mut ctx = h.context(256);
    ctx.events = prepared.events;
    ctx.waker = prepared.waker;
    net.lock().unwrap().activate(ctx).unwrap();
    let mut peer = listener.accept().unwrap().0;
    peer.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
    peer.set_write_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    h.tx(255, &packet(&[0x39; 60]));
    for head in 0..256 {
        h.rx(head, 100);
    }
    peer.write_all(&wire(&[0x42; 14]).repeat(256)).unwrap();
    control.start().unwrap();
    assert_eq!(read_wire(&mut peer), [0x39; 60]);
    let deadline = Instant::now() + Duration::from_secs(3);
    // No new guest kicks or peer writes: production readiness must continue RX.
    loop {
        let device = net.lock().unwrap();
        assert!(!device.failed);
        if h.used(RX) == 256 {
            break;
        }
        assert!(Instant::now() < deadline, "RX budget continuation stalled");
        drop(device);
        std::thread::yield_now();
    }
    control.stop().unwrap();
    assert_eq!(h.used(TX), 1);
    for head in 0..256u16 {
        assert_eq!(
            h.bytes(DATA + u64::from(head) * STRIDE, 26),
            receive_packet(&[0x42; 14])
        );
    }
    net.lock().unwrap().reset().unwrap();
    workers.0.shutdown().unwrap();
}
