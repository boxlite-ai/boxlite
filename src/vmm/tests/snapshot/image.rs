// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
mod linux {
    use std::{
        fs::{self, File},
        io::{self, Read, Write},
    };

    use vm_memory::{Bytes, GuestAddress};

    use crate::{
        ControlReason, Error, Result,
        events::EventLoop,
        lifecycle::Lifecycle,
        memory::{GuestRam, MMIO_HOLE_START, X86_LAYOUT},
        snapshot::image::{HEADER_LEN, Header, MAGIC, VERSION, create_new_file, write_to},
    };

    const MIB: usize = 1 << 20;
    const PAGE: usize = 4096;

    impl Header {
        pub(crate) fn read_from(
            reader: &mut impl Read,
            state_len: u64,
            memory_len: u64,
        ) -> Result<Self> {
            let mut bytes = [0; HEADER_LEN];
            reader.read_exact(&mut bytes).map_err(Error::Snapshot)?;
            let invalid =
                |reason| Error::Snapshot(io::Error::new(io::ErrorKind::InvalidData, reason));
            if &bytes[..8] != MAGIC
                || u32::from_le_bytes(bytes[8..12].try_into().unwrap()) != VERSION
            {
                return Err(invalid("unknown snapshot magic or version"));
            }
            let header = Self {
                vcpus: u32::from_le_bytes(bytes[12..16].try_into().unwrap()),
                ram_len: u64::from_le_bytes(bytes[16..24].try_into().unwrap()),
                machine_len: u64::from_le_bytes(bytes[24..32].try_into().unwrap()),
            };
            if (HEADER_LEN as u64).checked_add(header.machine_len) != Some(state_len)
                || header.ram_len != memory_len
            {
                return Err(invalid("snapshot lengths do not match the files"));
            }
            Ok(header)
        }
    }

    #[derive(Default)]
    struct RecordingWriter {
        output: Vec<u8>,
        writes: Vec<usize>,
        flushed: bool,
    }

    impl Write for RecordingWriter {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.output.extend_from_slice(buf);
            self.writes.push(buf.len());
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            self.flushed = true;
            Ok(())
        }
    }

    #[test]
    fn v1_header_and_packed_ram_skip_mmio_and_respect_chunk_boundaries() {
        let ranges = X86_LAYOUT.ranges(MMIO_HOLE_START + PAGE as u64).unwrap();
        assert_eq!(
            ranges,
            [
                (GuestAddress(0), MMIO_HOLE_START as usize),
                (GuestAddress(1 << 32), PAGE)
            ]
        );
        assert_eq!(
            X86_LAYOUT.ranges(PAGE as u64 + 1).unwrap_err().kind(),
            io::ErrorKind::InvalidInput
        );
        let low = GuestAddress(MMIO_HOLE_START - (MIB + PAGE) as u64);
        let high = ranges[1].0;
        let ram = GuestRam::new(&[(low, MIB + PAGE), (high, PAGE)]).unwrap();
        ram.boot_memory()
            .write_slice(&vec![0x35; MIB], low)
            .unwrap();
        ram.boot_memory()
            .write_slice(&[0x4d; PAGE], GuestAddress(low.0 + MIB as u64))
            .unwrap();
        ram.boot_memory().write_slice(&[0xc7; PAGE], high).unwrap();
        let machine = b"machine";
        let mut state_writer = RecordingWriter::default();
        let mut memory_writer = RecordingWriter::default();

        write_to(&mut state_writer, &mut memory_writer, 2, machine, &ram).unwrap();

        assert!(state_writer.flushed && memory_writer.flushed);
        assert_eq!(state_writer.writes, [32, machine.len()]);
        assert_eq!(memory_writer.writes, [MIB, PAGE, PAGE]);
        let (header, body) = state_writer.output.split_at(32);
        assert_eq!(&header[..8], b"BXLVMST1");
        assert_eq!(&header[8..12], &1u32.to_le_bytes());
        assert_eq!(&header[12..16], &2u32.to_le_bytes());
        assert_eq!(&header[16..24], &((MIB + 2 * PAGE) as u64).to_le_bytes());
        assert_eq!(&header[24..32], &(machine.len() as u64).to_le_bytes());
        assert_eq!(body, machine);
        let payload = memory_writer.output;
        assert_eq!(&payload[..MIB], vec![0x35; MIB]);
        assert_eq!(&payload[MIB..MIB + PAGE], &[0x4d; PAGE]);
        assert_eq!(&payload[MIB + PAGE..], &[0xc7; PAGE]);
    }

    #[test]
    fn header_reader_rejects_truncation_and_bad_framing() {
        let ram = GuestRam::new(&[(GuestAddress(0), PAGE)]).unwrap();
        let mut state = Vec::new();
        let mut memory = Vec::new();
        write_to(&mut state, &mut memory, 2, b"state", &ram).unwrap();
        let state_len = state.len() as u64;
        let memory_len = memory.len() as u64;
        let header = Header::read_from(&mut state.as_slice(), state_len, memory_len).unwrap();
        assert_eq!(
            (header.vcpus, header.ram_len, header.machine_len),
            (2, PAGE as u64, 5)
        );

        assert!(matches!(
            Header::read_from(&mut &state[..31], 31, memory_len),
            Err(Error::Snapshot(error)) if error.kind() == io::ErrorKind::UnexpectedEof
        ));
        for len in [state_len - 1, state_len + 1] {
            assert!(Header::read_from(&mut state.as_slice(), len, memory_len).is_err());
        }
        for len in [memory_len - 1, memory_len + 1] {
            assert!(Header::read_from(&mut state.as_slice(), state_len, len).is_err());
        }
        for offset in [0, 8] {
            let mut corrupt = state.clone();
            corrupt[offset] ^= 0xff;
            assert!(Header::read_from(&mut corrupt.as_slice(), state_len, memory_len).is_err());
        }
        state[24..32].copy_from_slice(&u64::MAX.to_le_bytes());
        assert!(Header::read_from(&mut state.as_slice(), state_len, memory_len).is_err());
    }

    #[test]
    fn memory_write_or_flush_failure_leaves_both_files_in_place() {
        struct FailingMemory {
            writer: File,
            fail_flush: bool,
        }

        impl Write for FailingMemory {
            fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
                if self.fail_flush {
                    self.writer.write(buf)
                } else {
                    Err(io::Error::other("disk write failed"))
                }
            }

            fn flush(&mut self) -> io::Result<()> {
                Err(io::Error::other("disk flush failed"))
            }
        }

        let ram = GuestRam::new(&[(GuestAddress(0), PAGE)]).unwrap();
        for (fail_flush, message) in [(false, "disk write failed"), (true, "disk flush failed")] {
            let dir = tempfile::tempdir().unwrap();
            let state_path = dir.path().join("state");
            let memory_path = dir.path().join("memory");
            let mut state = create_new_file(&state_path).unwrap();
            let mut memory = FailingMemory {
                writer: create_new_file(&memory_path).unwrap(),
                fail_flush,
            };
            assert!(matches!(
                write_to(&mut state, &mut memory, 1, b"state", &ram),
                Err(Error::Snapshot(error)) if error.to_string() == message
            ));
            drop((state, memory));
            assert_eq!(fs::metadata(&state_path).unwrap().len(), 37);
            let expected_memory_len = if fail_flush { PAGE as u64 } else { 0 };
            assert_eq!(
                fs::metadata(&memory_path).unwrap().len(),
                expected_memory_len
            );
        }
    }

    #[test]
    fn stop_during_or_after_writeout_leaves_both_complete_files_in_place() {
        struct StopOnWrite<'a> {
            writer: File,
            stop: Option<&'a Lifecycle>,
        }

        impl Write for StopOnWrite<'_> {
            fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
                if let Some(lifecycle) = self.stop.take() {
                    lifecycle.stop();
                }
                self.writer.write(buf)
            }

            fn flush(&mut self) -> io::Result<()> {
                self.writer.flush()
            }
        }

        let ram = GuestRam::new(&[(GuestAddress(0), MIB + PAGE)]).unwrap();
        for stop_during_write in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let state_path = dir.path().join("state");
            let memory_path = dir.path().join("memory");
            let events = EventLoop::new().unwrap();
            let lifecycle = Lifecycle::new(events.sender(), true);
            let mut state = create_new_file(&state_path).unwrap();
            let mut memory = StopOnWrite {
                writer: create_new_file(&memory_path).unwrap(),
                stop: stop_during_write.then_some(&lifecycle),
            };
            let result = write_to(&mut state, &mut memory, 1, b"state", &ram);
            assert!(result.is_ok());
            drop((state, memory));
            if !stop_during_write {
                lifecycle.stop();
            }
            assert!(matches!(
                lifecycle.finish_export(result),
                Err(Error::Control {
                    operation: "export",
                    reason: ControlReason::TerminalOutcome,
                })
            ));
            assert_eq!(fs::metadata(&state_path).unwrap().len(), 37);
            assert_eq!(
                fs::metadata(&memory_path).unwrap().len(),
                (MIB + PAGE) as u64
            );
        }
    }
}

#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
#[test]
fn export_is_unsupported_on_this_host() {
    use super::ControlRegistry;
    use crate::{ControlReason, Error, events::EventLoop, lifecycle::Lifecycle};
    use std::sync::Arc;

    let events = EventLoop::new().unwrap();
    let lifecycle = Arc::new(Lifecycle::new(events.sender(), true));
    let control = ControlRegistry::default().finish(lifecycle);
    let dir = tempfile::tempdir().unwrap();
    let state = dir.path().join("state");
    let memory = dir.path().join("memory");
    assert!(matches!(
        control.export(&state, &memory),
        Err(Error::Control {
            operation: "export",
            reason: ControlReason::Unsupported
        })
    ));
    assert!(!state.exists() && !memory.exists());
}
