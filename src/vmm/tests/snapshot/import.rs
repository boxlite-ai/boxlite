// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::io::{self, Read};

use crate::memory::GuestRam;
use vm_memory::{Bytes, GuestAddress};

struct Source {
    remaining: usize,
    largest: usize,
    position: usize,
}
impl Read for Source {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        self.largest = self.largest.max(bytes.len());
        let len = bytes.len().min(self.remaining).min(65537);
        for (i, byte) in bytes[..len].iter_mut().enumerate() {
            *byte = (self.position + i) as u8;
        }
        self.position += len;
        self.remaining -= len;
        Ok(len)
    }
}

#[test]
fn import_streams_arbitrary_short_reads_in_bounded_chunks() {
    let len = (2 << 20) + 37;
    let mut source = Source {
        remaining: len,
        largest: 0,
        position: 0,
    };
    let ram = GuestRam::from_reader(len, &mut source).unwrap();
    assert_eq!(source.remaining, 0);
    assert_eq!(source.largest, 1 << 20);
    let mut buffer = vec![0; len];
    ram.memory()
        .read_slice(&mut buffer, GuestAddress(0))
        .unwrap();
    assert!(buffer.iter().enumerate().all(|(i, &byte)| byte == i as u8));
}

#[test]
fn import_propagates_truncated_and_failed_sources() {
    assert!(GuestRam::from_reader(4096, &mut &b"short"[..]).is_err());
    struct Failed;
    impl Read for Failed {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("injected read failure"))
        }
    }
    assert!(GuestRam::from_reader(4096, &mut Failed).is_err());
}
