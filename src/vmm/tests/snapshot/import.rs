// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{
    cell::Cell,
    fs::{self, File},
    io::{self, Read},
};

use boxlite_hypervisor::{X86IrqchipState, X86VcpuState, X86VmState};
use vm_memory::{Bytes, GuestAddress};

use super::{image, state};
use crate::{
    Error, Vm, VmStatus,
    memory::{GuestRam, MMIO_HOLE_START},
    mock_vm::{Call, MockVm},
    snapshot::{
        restore::from_readers,
        state::{MachineState, VcpuRecord},
    },
};

#[path = "execution.rs"]
mod execution;
#[path = "restore.rs"]
mod restore;

const PAGE: usize = 4096;
const MIB: usize = 1 << 20;

fn machine(count: u8) -> MachineState {
    MachineState {
        vcpus: (0..count)
            .map(|id| {
                let state = X86VcpuState {
                    regs: Default::default(),
                    sregs: Default::default(),
                    fpu: Default::default(),
                    xsave: vec![],
                    cpuid: vec![],
                    msrs: vec![],
                    xcrs: Default::default(),
                    debug_regs: Default::default(),
                    events: Default::default(),
                    mp_state: Default::default(),
                    lapic: Default::default(),
                    tsc_khz: 1000,
                };
                let mut record = VcpuRecord { id, state };
                record.state.regs.rax = u64::from(id) + 10;
                record
            })
            .collect(),
        platform: X86VmState {
            irqchips: [
                X86IrqchipState::pic(0, Default::default()),
                X86IrqchipState::pic(1, Default::default()),
                X86IrqchipState::ioapic(Default::default()),
            ],
            pit: Some(Default::default()),
            clock: Default::default(),
        },
    }
}

fn snapshot(count: u32, payload: &[u8]) -> (Vec<u8>, Vec<u8>) {
    let ram = GuestRam::new(&[(GuestAddress(0), PAGE)]).unwrap();
    let mut state = Vec::new();
    let mut memory = Vec::new();
    image::write_to_checked(&mut state, &mut memory, count, payload, &ram, || Ok(())).unwrap();
    (state, memory)
}

struct ShortReads<'a> {
    bytes: &'a [u8],
    largest: &'a Cell<usize>,
}

impl Read for ShortReads<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
        assert!(bytes.len() <= MIB);
        self.largest.set(self.largest.get().max(bytes.len()));
        let len = bytes.len().min(self.bytes.len()).min(65537);
        bytes[..len].copy_from_slice(&self.bytes[..len]);
        self.bytes = &self.bytes[len..];
        Ok(len)
    }
}

#[test]
fn ram_import_streams_short_reads_across_the_mmio_hole() {
    let low_len = 2 * MIB + PAGE;
    let low = GuestAddress(MMIO_HOLE_START - low_len as u64);
    let high = GuestAddress(1 << 32);
    let mut bytes: Vec<_> = (0..low_len).map(|index| (index % 251) as u8).collect();
    bytes.extend([0xd6; PAGE]);
    let largest = Cell::new(0);
    let mut reader = ShortReads {
        bytes: &bytes,
        largest: &largest,
    };
    let ram = GuestRam::new(&[(low, low_len), (high, PAGE)]).unwrap();

    ram.read_image(&mut reader).unwrap();

    assert!(reader.bytes.is_empty());
    assert_eq!(largest.get(), MIB);
    for (address, expected) in [(low, &bytes[..low_len]), (high, &bytes[low_len..])] {
        let mut actual = vec![0; expected.len()];
        ram.boot_memory().read_slice(&mut actual, address).unwrap();
        assert_eq!(actual, expected);
    }
}

#[test]
fn import_consumes_both_readers_with_short_reads() {
    for count in [1, 64] {
        let (state, memory) = snapshot(u32::from(count), &machine(count).encode().unwrap());
        let largest = Cell::new(0);
        let mut state_reader = ShortReads {
            bytes: &state,
            largest: &largest,
        };
        let mut memory_reader = ShortReads {
            bytes: &memory,
            largest: &largest,
        };
        let vm = from_readers(&mut state_reader, &mut memory_reader, |_| {
            Ok(|| Ok(MockVm::new()))
        })
        .unwrap();

        assert_eq!(vm.control().status(), VmStatus::Created);
        assert!(state_reader.bytes.is_empty());
        assert!(memory_reader.bytes.is_empty());
    }
}

fn reject_before_host_prepare(mut reader: impl Read) -> io::Error {
    let error = from_readers::<MockVm, fn() -> boxlite_hypervisor::Result<MockVm>>(
        &mut reader,
        &mut io::empty(),
        |_| panic!("malformed snapshot reached host preparation"),
    )
    .unwrap_err();
    let Error::Snapshot(error) = error else {
        panic!("expected snapshot error, got {error:?}");
    };
    error
}

#[test]
fn malformed_headers_and_machine_records_fail_before_host_preparation() {
    let payload = machine(2).encode().unwrap();
    let (valid, _) = snapshot(2, &payload);
    for (offset, value) in [
        (0, 0),   // magic
        (8, 2),   // version
        (12, 0),  // zero vCPUs
        (12, 65), // too many vCPUs
        (12, 1),  // count disagrees with Postcard
    ] {
        let mut invalid = valid.clone();
        invalid[offset] = value;
        assert_eq!(
            reject_before_host_prepare(invalid.as_slice()).kind(),
            io::ErrorKind::InvalidData
        );
    }
    let mut unaligned = valid.clone();
    unaligned[16] = 1;
    assert_eq!(
        reject_before_host_prepare(unaligned.as_slice()).kind(),
        io::ErrorKind::InvalidData
    );
    for (offset, value) in [
        (16, 0),
        (16, u64::MAX),
        (24, 0),
        (24, image::MAX_MACHINE_STATE_LEN + 1),
    ] {
        let mut invalid = valid.clone();
        invalid[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
        assert_eq!(
            reject_before_host_prepare(invalid.as_slice()).kind(),
            io::ErrorKind::InvalidData
        );
    }
    for ids in [[0, 0], [1, 0], [0, 2]] {
        let mut state = machine(2);
        for (record, id) in state.vcpus.iter_mut().zip(ids) {
            record.id = id;
        }
        let (invalid, _) = snapshot(2, &state.encode().unwrap());
        let error = reject_before_host_prepare(invalid.as_slice());
        assert!(error.to_string().contains("contiguous and ordered"));
    }
    let mut trailing = payload.clone();
    trailing.push(0);
    let excessive_count = postcard::to_allocvec(&usize::MAX).unwrap();
    for invalid in [&payload[..1], &trailing, &excessive_count] {
        let (invalid, _) = snapshot(2, invalid);
        assert_eq!(
            reject_before_host_prepare(invalid.as_slice()).kind(),
            io::ErrorKind::InvalidData
        );
    }
}

#[test]
fn machine_import_rejects_missing_pit() {
    let mut state = machine(1);
    state.platform.pit = None;
    let (bytes, _) = snapshot(1, &state.encode().unwrap());

    let error = reject_before_host_prepare(bytes.as_slice());
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(error.to_string().contains("PIT"));
}

#[test]
fn machine_import_rejects_32_bit_paged_pae() {
    let mut state = machine(2);
    let sregs = &mut state.vcpus[1].state.sregs;
    sregs.cr0 = 1 << 31;
    sregs.cr4 = 1 << 5;
    let (bytes, _) = snapshot(2, &state.encode().unwrap());

    let error = reject_before_host_prepare(bytes.as_slice());
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(error.to_string().contains("32-bit paged PAE"));
}

#[test]
fn machine_import_rejects_out_of_order_irqchip_ids() {
    let mut state = machine(1);
    state.platform.irqchips.swap(0, 1);
    let (bytes, _) = snapshot(1, &state.encode().unwrap());

    let error = reject_before_host_prepare(bytes.as_slice());
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(error.to_string().contains("IRQ chip IDs"));
}

#[test]
fn machine_import_rejects_duplicate_irqchip_ids() {
    let mut state = machine(1);
    state.platform.irqchips[1] = X86IrqchipState::pic(0, Default::default());
    let (bytes, _) = snapshot(1, &state.encode().unwrap());
    let mut reader = bytes.as_slice();
    let header = image::Header::read(&mut reader).unwrap();

    let error = header
        .read_machine(&mut reader)
        .expect_err("machine import accepted duplicate IRQ chip IDs");
    assert!(matches!(
        error,
        Error::Snapshot(error) if error.kind() == io::ErrorKind::InvalidData
    ));
}

#[test]
fn file_import_rejects_truncated_or_trailing_state_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let state_path = dir.path().join("state");
    let memory_path = dir.path().join("memory");
    let (mut state, memory) = snapshot(1, &machine(1).encode().unwrap());
    fs::write(&memory_path, memory).unwrap();
    state.push(0);
    fs::write(&state_path, &state).unwrap();
    assert!(matches!(
        Vm::from_state(&state_path, &memory_path),
        Err(Error::Snapshot(error)) if error.kind() == io::ErrorKind::InvalidData
    ));

    fs::write(&state_path, &state[..state.len() - 2]).unwrap();
    assert!(matches!(
        Vm::from_state(&state_path, &memory_path),
        Err(Error::Snapshot(error)) if error.kind() == io::ErrorKind::UnexpectedEof
    ));
}

#[test]
fn file_import_rejects_either_missing_file() {
    let dir = tempfile::tempdir().unwrap();
    let state_path = dir.path().join("state");
    let memory_path = dir.path().join("memory");
    let missing_path = dir.path().join("missing");
    let (state, memory) = snapshot(1, &machine(1).encode().unwrap());
    fs::write(&state_path, state).unwrap();
    fs::write(&memory_path, memory).unwrap();
    for (state_path, memory_path) in [(&state_path, &missing_path), (&missing_path, &memory_path)] {
        assert!(matches!(
            Vm::from_state(state_path, memory_path),
            Err(Error::Snapshot(error)) if error.kind() == io::ErrorKind::NotFound
        ));
    }
}

#[test]
fn file_import_rejects_short_or_long_memory_before_host_creation() {
    let dir = tempfile::tempdir().unwrap();
    let state_path = dir.path().join("state");
    let path = dir.path().join("memory");
    let (state, mut memory) = snapshot(1, &machine(1).encode().unwrap());
    fs::write(&state_path, &state).unwrap();
    memory.push(0);
    for (length, kind) in [
        (PAGE - 1, io::ErrorKind::UnexpectedEof),
        (PAGE + 1, io::ErrorKind::InvalidData),
    ] {
        fs::write(&path, &memory[..length]).unwrap();
        assert!(matches!(
            Vm::from_state(&state_path, &path),
            Err(Error::Snapshot(error)) if error.kind() == io::ErrorKind::InvalidData
        ));

        let result = from_readers::<MockVm, _>(
            &mut state.as_slice(),
            &mut File::open(&path).unwrap(),
            |_| Ok(|| panic!("incorrect RAM length reached host creation")),
        );
        assert!(matches!(result, Err(Error::Snapshot(error)) if error.kind() == kind));
    }
}

#[test]
fn payload_read_errors_do_not_create_a_vm() {
    let payload = machine(1).encode().unwrap();
    let (state, memory) = snapshot(1, &payload);

    struct Fail;
    impl Read for Fail {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("RAM read failed"))
        }
    }

    let never_create =
        |_: &[(GuestAddress, usize)]| -> crate::Result<fn() -> boxlite_hypervisor::Result<MockVm>> {
            Ok(|| panic!("incomplete RAM reached host creation"))
        };
    let result = from_readers(
        &mut state.as_slice(),
        &mut memory[..memory.len() - 1].chain(Fail),
        never_create,
    );
    assert!(matches!(result, Err(Error::Snapshot(e)) if e.to_string() == "RAM read failed"));
}

#[test]
fn host_creation_and_failed_registration_are_constructor_errors() {
    let (state, memory) = snapshot(1, &machine(1).encode().unwrap());
    let result = from_readers::<MockVm, _>(&mut state.as_slice(), &mut memory.as_slice(), |_| {
        Ok(|| {
            Err(boxlite_hypervisor::Error::CreateVm(io::Error::other(
                "create failure",
            )))
        })
    });
    assert!(matches!(
        result,
        Err(Error::Hypervisor(boxlite_hypervisor::Error::CreateVm(error)))
            if error.to_string() == "create failure"
    ));

    let host = MockVm::failing_at(&[0]);
    let calls = host.log();
    let result = from_readers(&mut state.as_slice(), &mut memory.as_slice(), |_| {
        Ok(move || Ok(host))
    });
    assert!(matches!(
        result,
        Err(Error::Hypervisor(
            boxlite_hypervisor::Error::MapMemory { .. }
        ))
    ));
    assert!(matches!(
        calls.lock().unwrap().as_slice(),
        [Call::Map { .. }, Call::Unmap { .. }]
    ));
}
