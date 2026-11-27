//! Bounded local SSH evidence; producers never wait for the collector.

use crate::{SshUsageEvent, SshUsageResponse};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

pub const SSH_USAGE_CAPACITY: usize = 128;

#[derive(Debug)]
pub struct SshUsageBuffer {
    events: Mutex<VecDeque<SshUsageEvent>>,
    dropped: AtomicU64,
}

impl Default for SshUsageBuffer {
    fn default() -> Self {
        Self {
            events: Mutex::new(VecDeque::with_capacity(SSH_USAGE_CAPACITY)),
            dropped: AtomicU64::new(0),
        }
    }
}

impl SshUsageBuffer {
    /// Full or contended buffers drop the observation rather than delaying SSH.
    pub fn try_record(&self, event: SshUsageEvent) -> bool {
        if let Ok(mut events) = self.events.try_lock() {
            if events.len() < SSH_USAGE_CAPACITY {
                events.push_back(event);
                return true;
            }
        }
        self.dropped.fetch_add(1, Ordering::Relaxed);
        false
    }

    /// Called by a background collector; retains the allocated queue capacity.
    pub fn take(&self) -> SshUsageResponse {
        let mut events = self
            .events
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        SshUsageResponse {
            events: events.drain(..).collect(),
            dropped_total: self.dropped.load(Ordering::Relaxed),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    fn event(sequence: u64) -> SshUsageEvent {
        SshUsageEvent {
            id: sequence.to_string(),
            occurred_at_ms: sequence,
        }
    }

    #[test]
    fn ssh_usage_capacity_drops_and_drain_preserves_source_order() {
        let buffer = SshUsageBuffer::default();
        for sequence in 0..SSH_USAGE_CAPACITY as u64 {
            assert!(buffer.try_record(event(sequence)));
        }
        assert!(!buffer.try_record(event(999)));
        let batch = buffer.take();
        assert_eq!(batch.events.len(), SSH_USAGE_CAPACITY);
        assert_eq!(batch.dropped_total, 1);
        assert_eq!(batch.events[0].id, "0");
        assert_eq!(
            batch.events[SSH_USAGE_CAPACITY - 1].occurred_at_ms,
            (SSH_USAGE_CAPACITY - 1) as u64
        );
        assert!(buffer.take().events.is_empty());
        assert!(buffer.try_record(event(1000)));
    }

    #[test]
    fn ssh_usage_contention_never_waits_for_the_consumer() {
        let buffer = Arc::new(SshUsageBuffer::default());
        let consumer = buffer.events.lock().unwrap();
        let (sent, received) = mpsc::channel();
        let producer = buffer.clone();
        let task = std::thread::spawn(move || sent.send(producer.try_record(event(1))).unwrap());
        let result = received.recv_timeout(Duration::from_secs(1));
        drop(consumer);
        task.join().unwrap();
        assert!(!result.expect("producer waited for consumer"));
        assert_eq!(buffer.take().dropped_total, 1);
    }
}
