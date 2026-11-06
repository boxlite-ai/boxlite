// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Writable guest buffers retained until a packet or event can be delivered.

use super::{
    bad_queue,
    packet::{HEADER_LEN, Packet},
};
use crate::{memory::GuestMemoryMmap, virtio::DeviceError};
use virtio_queue::{DescriptorChain, desc::split::Descriptor};
use vm_memory::{Bytes, GuestMemory, Permissions};

pub(super) struct Buffer {
    pub head: u16,
    descriptors: Vec<Descriptor>,
    capacity: usize,
}

impl Buffer {
    pub fn new(chain: DescriptorChain<&GuestMemoryMmap>) -> Result<Self, DeviceError> {
        let head = chain.head_index();
        let memory = chain.memory();
        let mut descriptors = Vec::new();
        let mut capacity = 0usize;
        for descriptor in chain.clone() {
            if !descriptor.is_write_only()
                || !memory.check_range(
                    descriptor.addr(),
                    descriptor.len() as usize,
                    Permissions::Write,
                )
            {
                return Err(bad_queue());
            }
            capacity = capacity
                .checked_add(descriptor.len() as usize)
                .ok_or_else(bad_queue)?;
            descriptors.push(descriptor);
        }
        Ok(Self {
            head,
            descriptors,
            capacity,
        })
    }

    /// Writes the stream prefix that fits, returning its wire length. A header-only
    /// buffer is returned unused when data is pending, leaving that data queued.
    pub fn write_packet(
        &self,
        memory: &GuestMemoryMmap,
        packet: &Packet,
    ) -> Result<usize, DeviceError> {
        let capacity = self
            .capacity
            .checked_sub(HEADER_LEN)
            .ok_or_else(bad_queue)?;
        let count = packet.payload.len().min(capacity);
        if count == 0 && !packet.payload.is_empty() {
            return Ok(0);
        }
        let mut header = packet.header.clone();
        header.len = count as u32;
        let mut bytes = header.encode().to_vec();
        bytes.extend_from_slice(&packet.payload[..count]);
        self.write(memory, &bytes)?;
        Ok(bytes.len())
    }

    pub fn write(&self, memory: &GuestMemoryMmap, mut bytes: &[u8]) -> Result<(), DeviceError> {
        if bytes.len() > self.capacity {
            return Err(bad_queue());
        }
        for descriptor in &self.descriptors {
            let count = bytes.len().min(descriptor.len() as usize);
            memory
                .write_slice(&bytes[..count], descriptor.addr())
                .map_err(|_| bad_queue())?;
            bytes = &bytes[count..];
            if bytes.is_empty() {
                break;
            }
        }
        Ok(())
    }
}
