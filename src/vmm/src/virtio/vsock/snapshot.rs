// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Versioned device state; host streams are replaced by a transport reset.

use crate::virtio::{DeviceError, DeviceSnapshot};
use virtio_queue::QueueState;

const FORMAT: u32 = u32::from_le_bytes(*b"VSOK");
const VERSION: u32 = 1;
const HEADER_LEN: usize = 10;
const QUEUE_LEN: usize = 34;
const INVALID: DeviceError = DeviceError::NeedsReset("vsock snapshot");

pub(super) struct State {
    pub cid: u64,
    pub features_set: bool,
    pub queues: Option<Vec<QueueState>>,
}

impl State {
    pub fn encode(&self) -> DeviceSnapshot {
        let mut payload = self.cid.to_le_bytes().to_vec();
        payload.push(u8::from(self.features_set));
        payload.push(u8::from(self.queues.is_some()));
        if let Some(queues) = &self.queues {
            for q in queues {
                for value in [q.max_size, q.next_avail, q.next_used, q.size] {
                    payload.extend(value.to_le_bytes());
                }
                payload.extend([u8::from(q.event_idx_enabled), u8::from(q.ready)]);
                for value in [q.desc_table, q.avail_ring, q.used_ring] {
                    payload.extend(value.to_le_bytes());
                }
            }
        }
        DeviceSnapshot {
            format: FORMAT,
            version: VERSION,
            payload,
        }
    }

    pub fn decode(state: DeviceSnapshot, cid: u64) -> Result<Self, DeviceError> {
        let bytes = &state.payload;
        if state.format != FORMAT || state.version != VERSION || bytes.len() < HEADER_LEN {
            return Err(INVALID);
        }
        let saved_cid = u64::from_le_bytes(bytes[..8].try_into().unwrap());
        let features_set = match bytes[8] {
            0 => false,
            1 => true,
            _ => return Err(INVALID),
        };
        let count = match bytes[9] {
            0 => 0,
            1 if features_set => 3,
            _ => return Err(INVALID),
        };
        if saved_cid != cid || bytes.len() != HEADER_LEN + count * QUEUE_LEN {
            return Err(INVALID);
        }
        let mut queues = Vec::with_capacity(count);
        for bytes in bytes[HEADER_LEN..].as_chunks::<QUEUE_LEN>().0 {
            let word = |offset| u16::from_le_bytes(bytes[offset..offset + 2].try_into().unwrap());
            let address =
                |offset| u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap());
            // This device offers no EVENT_IDX or INDIRECT_DESC feature bits.
            if word(0) != 256 || bytes[8] != 0 || bytes[9] != 1 {
                return Err(INVALID);
            }
            queues.push(QueueState {
                max_size: word(0),
                next_avail: word(2),
                next_used: word(4),
                size: word(6),
                event_idx_enabled: false,
                ready: true,
                desc_table: address(10),
                avail_ring: address(18),
                used_ring: address(26),
            });
        }
        Ok(Self {
            cid,
            features_set,
            queues: (count != 0).then_some(queues),
        })
    }
}
