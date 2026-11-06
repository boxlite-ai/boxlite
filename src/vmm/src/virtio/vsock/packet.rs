// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! VIRTIO 1.2 §5.10 packet encoding. No native-layout casts of guest data.

use std::io::{self, Read};

pub(super) const HEADER_LEN: usize = 44;
pub(super) const BUFFER_SIZE: usize = 64 * 1024;
pub(super) const HOST_CID: u64 = 2;
pub(super) const STREAM: u16 = 1;
pub(super) const REQUEST: u16 = 1;
pub(super) const RESPONSE: u16 = 2;
pub(super) const RST: u16 = 3;
pub(super) const SHUTDOWN: u16 = 4;
pub(super) const RW: u16 = 5;
pub(super) const CREDIT_UPDATE: u16 = 6;
pub(super) const CREDIT_REQUEST: u16 = 7;
pub(super) const RECEIVE: u32 = 1;
pub(super) const SEND: u32 = 2;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(super) struct Header {
    pub src_cid: u64,
    pub dst_cid: u64,
    pub src_port: u32,
    pub dst_port: u32,
    pub len: u32,
    pub socket_type: u16,
    pub op: u16,
    pub flags: u32,
    pub buf_alloc: u32,
    pub fwd_cnt: u32,
}

impl Header {
    pub fn decode(bytes: &[u8; HEADER_LEN]) -> Self {
        let u16_at = |i| u16::from_le_bytes(bytes[i..i + 2].try_into().unwrap());
        let u32_at = |i| u32::from_le_bytes(bytes[i..i + 4].try_into().unwrap());
        let u64_at = |i| u64::from_le_bytes(bytes[i..i + 8].try_into().unwrap());
        Self {
            src_cid: u64_at(0),
            dst_cid: u64_at(8),
            src_port: u32_at(16),
            dst_port: u32_at(20),
            len: u32_at(24),
            socket_type: u16_at(28),
            op: u16_at(30),
            flags: u32_at(32),
            buf_alloc: u32_at(36),
            fwd_cnt: u32_at(40),
        }
    }

    pub fn encode(&self) -> [u8; HEADER_LEN] {
        let mut bytes = [0; HEADER_LEN];
        bytes[0..8].copy_from_slice(&self.src_cid.to_le_bytes());
        bytes[8..16].copy_from_slice(&self.dst_cid.to_le_bytes());
        bytes[16..20].copy_from_slice(&self.src_port.to_le_bytes());
        bytes[20..24].copy_from_slice(&self.dst_port.to_le_bytes());
        bytes[24..28].copy_from_slice(&self.len.to_le_bytes());
        bytes[28..30].copy_from_slice(&self.socket_type.to_le_bytes());
        bytes[30..32].copy_from_slice(&self.op.to_le_bytes());
        bytes[32..36].copy_from_slice(&self.flags.to_le_bytes());
        bytes[36..40].copy_from_slice(&self.buf_alloc.to_le_bytes());
        bytes[40..44].copy_from_slice(&self.fwd_cnt.to_le_bytes());
        bytes
    }

    pub fn reply(&self, op: u16) -> Packet {
        Packet {
            header: Self {
                src_cid: self.dst_cid,
                dst_cid: self.src_cid,
                src_port: self.dst_port,
                dst_port: self.src_port,
                socket_type: self.socket_type,
                op,
                ..Self::default()
            },
            payload: Vec::new(),
        }
    }
}

#[derive(Debug)]
pub(super) struct Packet {
    pub header: Header,
    pub payload: Vec<u8>,
}

impl Packet {
    pub fn read(reader: &mut impl Read) -> io::Result<Self> {
        let mut bytes = [0; HEADER_LEN];
        reader.read_exact(&mut bytes)?;
        let header = Header::decode(&bytes);
        if header.len as usize > BUFFER_SIZE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "vsock payload exceeds receive buffer",
            ));
        }
        let mut payload = vec![0; header.len as usize];
        reader.read_exact(&mut payload)?;
        Ok(Self { header, payload })
    }
}
