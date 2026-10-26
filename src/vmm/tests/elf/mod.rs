// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Tests for the library-backed ELF adapter and guest visibility.

use std::io::{self, Cursor};

use vm_memory::{Bytes, GuestAddress};

use super::load_elf;
use crate::memory::{GuestMemoryMmap, GuestRam};

/// Physical start, file offset, file size, memory size and flags of each
/// fixture segment: code, data, and a BSS-only segment.
const SEGMENTS: [(u64, u64, u64, u64, u32); 3] = [
    (0x10_0000, 0x100, 8, 0x20, 5),
    (0x10_2000, 0x200, 4, 0x10, 6),
    (0x10_3000, 0, 0, 0x80, 6),
];
pub(crate) const ENTRY: u64 = 0x10_0000;
const RAM_SIZE: usize = 2 << 20;

fn put16(image: &mut [u8], offset: usize, value: u16) {
    image[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn put32(image: &mut [u8], offset: usize, value: u32) {
    image[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn put64(image: &mut [u8], offset: usize, value: u64) {
    image[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

/// Offset of program header `index` in the fixture.
fn header(index: usize) -> usize {
    64 + index * 56
}

/// A minimal x86_64 executable: three `PT_LOAD` segments whose virtual
/// addresses live in the kernel's negative half, as a real `vmlinux` has.
pub(crate) fn fixture() -> Vec<u8> {
    let mut image = vec![0u8; 0x204];
    image[..7].copy_from_slice(&[0x7f, b'E', b'L', b'F', 2, 1, 1]);
    put16(&mut image, 16, 2);
    put16(&mut image, 18, 62);
    put32(&mut image, 20, 1);
    put64(&mut image, 24, ENTRY);
    put64(&mut image, 32, 64);
    put16(&mut image, 52, 64);
    put16(&mut image, 54, 56);
    put16(&mut image, 56, SEGMENTS.len() as u16);
    image[0x100..0x108].copy_from_slice(b"CODE1234");
    image[0x200..0x204].copy_from_slice(b"DATA");
    for (index, (paddr, offset, filesz, memsz, flags)) in SEGMENTS.into_iter().enumerate() {
        let base = header(index);
        put32(&mut image, base, 1);
        put32(&mut image, base + 4, flags);
        put64(&mut image, base + 8, offset);
        put64(&mut image, base + 16, paddr + 0xffff_8000_0000_0000);
        put64(&mut image, base + 24, paddr);
        put64(&mut image, base + 32, filesz);
        put64(&mut image, base + 40, memsz);
        put64(&mut image, base + 48, 1);
    }
    image
}

fn ram(size: usize) -> GuestRam {
    GuestRam::new(&[(GuestAddress(0), size)]).expect("fresh guest RAM")
}

fn read(ram: &GuestMemoryMmap, address: u64, len: usize) -> Vec<u8> {
    let mut bytes = vec![0; len];
    ram.read_slice(&mut bytes, GuestAddress(address))
        .expect("read guest RAM");
    bytes
}

/// Loads an in-memory image through the reader a kernel file also goes through.
fn load(ram: &GuestMemoryMmap, image: &[u8]) -> io::Result<u64> {
    load_elf(ram, &mut Cursor::new(image))
}

#[test]
fn loads_physical_bytes_and_returns_the_kernel_entry() {
    let ram = ram(RAM_SIZE);
    let memory = ram.memory().as_ref();
    let image = fixture();

    assert_eq!(load(memory, &image).unwrap(), ENTRY);
    for (paddr, offset, filesz, memsz, _) in SEGMENTS {
        let loaded = read(memory, paddr, memsz as usize);
        assert_eq!(
            &loaded[..filesz as usize],
            &image[offset as usize..(offset + filesz) as usize]
        );
        assert!(
            loaded[filesz as usize..].iter().all(|&byte| byte == 0),
            "BSS must remain zero in fresh RAM"
        );
    }
}

#[test]
fn preserves_the_library_error_for_invalid_or_truncated_images() {
    let valid = fixture();
    for image in [&[][..], &[0u8; 64][..], &valid[..valid.len() - 1]] {
        let ram = ram(RAM_SIZE);
        let error = load(ram.memory().as_ref(), image).expect_err("invalid ELF");
        assert_eq!(error.kind(), io::ErrorKind::Other);
        assert!(
            error
                .get_ref()
                .and_then(|source| source.downcast_ref::<linux_loader::loader::Error>())
                .is_some(),
            "the library error must remain available: {error}"
        );
    }
}

/// Loads the kernel named by `VMM_KERNEL`, checks every segment against
/// `readelf`, then lets a KVM vCPU sum the loaded span and report it on an
/// I/O port.
#[test]
#[ignore = "requires Linux x86_64 with access to /dev/kvm, readelf, and VMM_KERNEL naming an x86_64 vmlinux"]
fn native_vmlinux_bytes_are_visible_to_a_kvm_vcpu() {
    use std::{process::Command, ptr::NonNull};

    use boxlite_hypervisor::{KvmVm, MemoryRegion, VcpuExit, X86BootRegisters, X86Segment};
    use vm_memory::GuestMemoryBackend;

    const RAM_SIZE: usize = 128 << 20;
    const PROBE_PORT: u16 = 0x500;

    let path = std::env::var_os("VMM_KERNEL")
        .expect("set VMM_KERNEL or run make test:integration:vmm:elf");
    let image = std::fs::read(&path).expect("read VMM_KERNEL");

    // readelf is an independent oracle for segment placement and the entry.
    let output = Command::new("readelf")
        .args(["--file-header", "--program-headers", "--wide"])
        .arg(&path)
        .env("LC_ALL", "C")
        .output()
        .expect("run readelf");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = String::from_utf8(output.stdout).unwrap();
    let mut expected_entry = None;
    let mut oracle = Vec::new();
    for line in text.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        if line.trim_start().starts_with("Entry point address:") {
            expected_entry = Some(parse_hex(fields[3]));
        } else if fields.first() == Some(&"LOAD") {
            oracle.push((
                parse_hex(fields[1]) as usize,
                parse_hex(fields[3]),
                parse_hex(fields[4]) as usize,
                parse_hex(fields[5]) as usize,
            ));
        }
    }
    assert!(!oracle.is_empty(), "readelf found no LOAD segments");
    let expected_entry = expected_entry.expect("readelf entry point");
    let start = oracle.iter().map(|segment| segment.1).min().unwrap();
    let end = oracle
        .iter()
        .map(|segment| segment.1 + segment.3 as u64)
        .max()
        .unwrap();
    assert!(
        end <= RAM_SIZE as u64,
        "the probe maps {RAM_SIZE} bytes of RAM; segments must end inside it"
    );

    // RAM is declared before the VM and vCPU so it outlives them during unwinding.
    let ram = ram(RAM_SIZE);
    let memory = ram.memory().as_ref();
    let mut kernel = std::fs::File::open(&path).expect("open VMM_KERNEL");
    assert_eq!(load_elf(memory, &mut kernel).unwrap(), expected_entry);
    let mut checksum = 0u32;
    for &(offset, paddr, filesz, memsz) in &oracle {
        let loaded = read(memory, paddr, memsz);
        assert_eq!(&loaded[..filesz], &image[offset..offset + filesz]);
        assert!(
            loaded[filesz..].iter().all(|&byte| byte == 0),
            "BSS at {paddr:#x} is not zero"
        );
        checksum = image[offset..offset + filesz]
            .iter()
            .fold(checksum, |sum, &byte| sum.wrapping_add(u32::from(byte)));
    }

    // A protected-mode program sums every byte of [start, end) and writes EAX
    // to the probe port; gaps between segments are untouched zero RAM.
    let mut program = vec![0x31, 0xc0, 0xbb];
    program.extend_from_slice(&(start as u32).to_le_bytes());
    program.push(0xb9);
    program.extend_from_slice(&((end - start) as u32).to_le_bytes());
    program.extend_from_slice(&[
        0x0f, 0xb6, 0x13, // movzx edx, byte [ebx]
        0x01, 0xd0, // add eax, edx
        0x43, // inc ebx
        0xe2, 0xf8, // loop
        0x66, 0xba, 0x00, 0x05, // mov dx, 0x500
        0xef, 0xf4, // out dx, eax; hlt
    ]);
    memory.write_slice(&program, GuestAddress(0x1000)).unwrap();
    for (index, descriptor) in [0u64, 0x00cf_9b00_0000_ffff, 0x00cf_9300_0000_ffff]
        .into_iter()
        .enumerate()
    {
        memory
            .write_slice(
                &descriptor.to_le_bytes(),
                GuestAddress(0x500 + index as u64 * 8),
            )
            .unwrap();
    }

    let vm = KvmVm::new().expect("create KVM VM");
    let region = MemoryRegion {
        guest_addr: 0,
        host_addr: NonNull::new(memory.get_host_address(GuestAddress(0)).unwrap()).unwrap(),
        size: RAM_SIZE,
    };
    // SAFETY: `ram` is declared before `vm` and `vcpu`, so it is dropped after
    // them, and no other host thread touches it during the probe.
    unsafe { vm.map_memory(&region) }.expect("map guest RAM");
    let mut vcpu = vm.create_vcpu(0).expect("create vCPU");
    vcpu.set_cpu_features(vm.supported_cpuid(), &[])
        .expect("set CPUID");
    vcpu.set_boot_registers(&X86BootRegisters {
        rip: 0x1000,
        rsp: 0x8000,
        rflags: 2,
        cr0: 1,
        code: X86Segment {
            base: 0,
            limit: u32::MAX,
            selector: 8,
            attributes: 0xc09b,
        },
        data: X86Segment {
            base: 0,
            limit: u32::MAX,
            selector: 16,
            attributes: 0xc093,
        },
        gdt_base: 0x500,
        gdt_limit: 23,
        ..X86BootRegisters::default()
    })
    .expect("set boot registers");

    let mut observed = None;
    for _ in 0..16 {
        match vcpu.run().expect("run vCPU") {
            VcpuExit::Interrupted => continue,
            VcpuExit::IoOut { port, bytes } => {
                assert_eq!(port, PROBE_PORT);
                observed = Some(u32::from_le_bytes(bytes.try_into().expect("32-bit OUT")));
                break;
            }
            exit => panic!("unexpected probe exit: {exit:?}"),
        }
    }
    assert_eq!(
        observed,
        Some(checksum),
        "guest checksum of the loaded kernel"
    );
    // Finish the OUT without executing HLT, which would wait in the kernel.
    vcpu.complete_pending_io().expect("complete pending I/O");

    fn parse_hex(field: &str) -> u64 {
        u64::from_str_radix(field.trim_start_matches("0x"), 16).expect("hex field")
    }
}
