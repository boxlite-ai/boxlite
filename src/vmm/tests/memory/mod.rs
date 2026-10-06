// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::io;

use vm_memory::{Bytes, GuestAddress};

use super::KernelMemory;

const LOAD_ADDR: u64 = 0x10_0000;
const PHDR: usize = 64;
const PHDR_SIZE: usize = 56;

fn put16(bytes: &mut [u8], offset: usize, value: u16) {
    bytes[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn put32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn put64(bytes: &mut [u8], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

fn fixture() -> Vec<u8> {
    let mut image = vec![0; 0x204];
    image[..7].copy_from_slice(b"\x7fELF\x02\x01\x01");
    put16(&mut image, 16, 2);
    put16(&mut image, 18, 62);
    put32(&mut image, 20, 1);
    put64(&mut image, 24, LOAD_ADDR);
    put64(&mut image, 32, PHDR as u64);
    put16(&mut image, 52, 64);
    put16(&mut image, 54, PHDR_SIZE as u16);
    put16(&mut image, 56, 3);

    // Physical addresses differ from the virtual addresses. The final segment
    // has no file bytes, so a copier that ignores BSS bounds will miss it.
    for (index, (address, offset, file_size, memory_size, flags)) in [
        (LOAD_ADDR, 0x100, 8, 0x20, 5),
        (LOAD_ADDR + 0x2000, 0x200, 4, 0x10, 6),
        (LOAD_ADDR + 0x3000, 0, 0, 0x80, 6),
    ]
    .into_iter()
    .enumerate()
    {
        let header = PHDR + index * PHDR_SIZE;
        put32(&mut image, header, 1);
        put32(&mut image, header + 4, flags);
        put64(&mut image, header + 8, offset);
        put64(&mut image, header + 16, address + 0xffff_8000_0000_0000);
        put64(&mut image, header + 24, address);
        put64(&mut image, header + 32, file_size);
        put64(&mut image, header + 40, memory_size);
        put64(&mut image, header + 48, 1);
    }
    image[0x100..0x108].copy_from_slice(b"CODE1234");
    image[0x200..0x204].copy_from_slice(b"DATA");
    image
}

fn reject(image: &[u8], reason: &str) {
    let error = KernelMemory::load(image, 2).err().expect("invalid kernel");
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(
        error.to_string().contains(reason),
        "{error}: wanted {reason}"
    );
}

#[test]
fn loads_physical_segments_and_zeroes_bss_and_gaps() {
    let kernel = KernelMemory::load(&fixture(), 2).unwrap();
    assert_eq!(kernel.entry, LOAD_ADDR);
    assert_eq!(kernel.kernel_end, LOAD_ADDR + 0x3080);
    let mut actual = vec![0xff; 0x3080];
    kernel
        .ram
        .read_slice(&mut actual, GuestAddress(LOAD_ADDR))
        .unwrap();
    let mut expected = vec![0; actual.len()];
    expected[..8].copy_from_slice(b"CODE1234");
    expected[0x2000..0x2004].copy_from_slice(b"DATA");
    assert_eq!(actual, expected);
    let mut low_memory = vec![0xff; LOAD_ADDR as usize];
    kernel
        .ram
        .read_slice(&mut low_memory, GuestAddress(0))
        .unwrap();
    assert!(low_memory.iter().all(|&byte| byte == 0));
}

#[test]
fn accepts_bss_ending_exactly_at_ram_boundary() {
    let mut image = fixture();
    put64(&mut image, PHDR + PHDR_SIZE * 2 + 40, 0x10_0000 - 0x3000);
    let kernel = KernelMemory::load(&image, 2).unwrap();
    assert_eq!(kernel.kernel_end, 0x20_0000);
    assert_eq!(
        kernel.ram.read_obj::<u8>(GuestAddress(0x1f_ffff)).unwrap(),
        0
    );
}

#[test]
fn alignment_uses_virtual_address_not_physical_address() {
    let mut image = fixture();
    put64(&mut image, PHDR + 48, 0x2000);
    put64(&mut image, PHDR + 16, 0x100);
    KernelMemory::load(&image, 2).unwrap();
    put64(&mut image, PHDR + 16, 0x101);
    reject(&image, "alignment");
    put64(&mut image, PHDR + 48, 3);
    reject(&image, "alignment");
}

#[test]
fn rejects_invalid_ram_sizes_before_allocation() {
    for size in [0, 3073, u32::MAX] {
        let error = KernelMemory::load(&fixture(), size).err().unwrap();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(error.to_string().contains(&size.to_string()));
    }
    let error = KernelMemory::load(&fixture(), 1).err().unwrap();
    assert!(error.to_string().contains("outside kernel RAM"));
}

#[test]
fn rejects_wrong_elf_format_and_header_sizes() {
    for offset in [0, 4, 5, 6, 16, 18, 20, 52] {
        let mut image = fixture();
        image[offset] = 0xff;
        reject(&image, "x86_64 ELF executable");
    }
    for offset in [54, 56] {
        let mut image = fixture();
        put16(&mut image, offset, 0);
        reject(&image, "program header table");
    }
    let mut image = fixture();
    put64(&mut image, 32, 63);
    reject(&image, "program header table");
    put64(&mut image, 32, u64::MAX);
    reject(&image, "file range overflow");
}

#[test]
fn rejects_every_truncated_prefix() {
    let image = fixture();
    for length in 0..image.len() {
        reject(&image[..length], "truncated");
    }
}

#[test]
fn rejects_invalid_segment_ranges_including_bss_only_segments() {
    for (offset, value, reason) in [
        (24, LOAD_ADDR - 1, "outside kernel RAM"),
        (24, u64::MAX - 1, "address overflow"),
        (32, 0x21, "memory size >= file size"),
        (40, 0, "memory size >= file size"),
        (40, 0x20_0000, "outside kernel RAM"),
        (8, 0x200, "truncated"),
        (8, u64::MAX - 1, "file range overflow"),
    ] {
        let mut image = fixture();
        put64(&mut image, PHDR + offset, value);
        reject(&image, reason);
    }
    let mut image = fixture();
    put64(&mut image, PHDR + PHDR_SIZE * 2 + 40, 0x20_0000);
    reject(&image, "segment 2: load range");
}

#[test]
fn rejects_overlapping_segments_even_when_overlap_is_only_bss() {
    for index in [1, 2] {
        let mut image = fixture();
        put64(&mut image, PHDR + PHDR_SIZE * index + 24, LOAD_ADDR + 8);
        reject(&image, "overlapping");
    }
}

#[test]
fn rejects_entries_in_unmapped_memory_data_and_bss() {
    for entry in [
        0,
        LOAD_ADDR - 1,
        LOAD_ADDR + 8,
        LOAD_ADDR + 0x2000,
        0x20_0000,
    ] {
        let mut image = fixture();
        put64(&mut image, 24, entry);
        reject(&image, "outside file-backed executable segments");
    }
    let mut image = fixture();
    put32(&mut image, PHDR + 4, 4);
    reject(&image, "outside file-backed executable segments");
}

#[test]
fn rejects_dynamic_images_and_images_without_load_segments() {
    for kind in [2, 3] {
        let mut image = fixture();
        put32(&mut image, PHDR + PHDR_SIZE, kind);
        reject(&image, "dynamic linking");
    }
    let mut image = fixture();
    for index in 0..3 {
        put32(&mut image, PHDR + PHDR_SIZE * index, 0);
    }
    reject(&image, "outside file-backed executable segments");
}

#[test]
fn ignores_notes_without_attempting_pvh_boot() {
    let mut image = fixture();
    put32(&mut image, PHDR + PHDR_SIZE * 2, 4);
    put64(&mut image, PHDR + PHDR_SIZE * 2 + 8, u64::MAX);
    let kernel = KernelMemory::load(&image, 2).unwrap();
    assert_eq!(kernel.entry, LOAD_ADDR);
    assert_eq!(kernel.kernel_end, LOAD_ADDR + 0x2010);
}

#[test]
#[ignore = "requires /dev/kvm, readelf, and VMM_KERNEL pointing to an x86_64 vmlinux"]
fn native_kernel_is_read_by_kvm() {
    use std::{fs::File, io::Read, process::Command, ptr::NonNull};

    use boxlite_hypervisor::{KvmVm, MemoryRegion, VcpuExit, X86BootRegisters, X86Segment};
    use vm_memory::GuestMemoryBackend;

    let path = std::env::var_os("VMM_KERNEL").expect("run make test:integration:vmm:kernel");
    let mut image = Vec::new();
    File::open(&path)
        .expect("open VMM_KERNEL")
        .take(128 * 1024 * 1024 + 1)
        .read_to_end(&mut image)
        .unwrap();
    assert!(
        image.len() <= 128 * 1024 * 1024,
        "probe kernel exceeds 128 MiB"
    );

    // readelf is an independent oracle for native-image segment placement.
    let output = Command::new("readelf")
        .args(["--program-headers", "--wide"])
        .env("LC_ALL", "C")
        .arg(&path)
        .output()
        .expect("run readelf");
    assert!(
        output.status.success(),
        "readelf: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let headers = String::from_utf8(output.stdout).unwrap();
    let hex = |word: &str| u64::from_str_radix(word.trim_start_matches("0x"), 16).unwrap();

    // Declare RAM before VM/vCPU, so reverse drop order remains safe on panic.
    let kernel = KernelMemory::load(&image, 128).unwrap();
    let mut expected_checksum = 0u32;
    let mut first_address = u64::MAX;
    let mut expected_end = 0;
    let mut segment_count = 0;
    for line in headers
        .lines()
        .filter(|line| line.trim_start().starts_with("LOAD "))
    {
        let fields: Vec<_> = line.split_whitespace().collect();
        let offset = hex(fields[1]) as usize;
        let address = hex(fields[3]);
        let file_size = hex(fields[4]) as usize;
        let memory_size = hex(fields[5]) as usize;
        let mut actual = vec![0xff; memory_size];
        kernel
            .ram
            .read_slice(&mut actual, GuestAddress(address))
            .unwrap();
        assert_eq!(&actual[..file_size], &image[offset..offset + file_size]);
        assert!(
            actual[file_size..].iter().all(|&byte| byte == 0),
            "BSS at {address:#x}"
        );
        expected_checksum = image[offset..offset + file_size]
            .iter()
            .fold(expected_checksum, |sum, &byte| {
                sum.wrapping_add(byte as u32)
            });
        first_address = first_address.min(address);
        expected_end = expected_end.max(address + memory_size as u64);
        segment_count += 1;
    }
    assert!(segment_count > 0);
    assert_eq!(kernel.kernel_end, expected_end);
    let entry_line = headers
        .lines()
        .find(|line| line.starts_with("Entry point "))
        .unwrap();
    assert_eq!(
        kernel.entry,
        hex(entry_line.split_whitespace().last().unwrap())
    );

    // A 32-bit test program sums every byte in the loaded kernel's physical
    // span, including zero-filled gaps/BSS, then returns EAX through port 0x500.
    // It deliberately does not jump to the Linux entry point.
    let mut program = vec![0x31, 0xc0, 0xbb]; // xor eax,eax; mov ebx,start
    program.extend_from_slice(&(first_address as u32).to_le_bytes());
    program.push(0xb9); // mov ecx,length
    program.extend_from_slice(&((expected_end - first_address) as u32).to_le_bytes());
    program.extend_from_slice(&[
        0x0f, 0xb6, 0x13, // movzx edx,byte [ebx]
        0x01, 0xd0, // add eax,edx
        0x43, // inc ebx
        0xe2, 0xf8, // loop back to movzx
        0x66, 0xba, 0x00, 0x05, // mov dx,0x500
        0xef, 0xf4, // out dx,eax; hlt
    ]);
    kernel
        .ram
        .write_slice(&program, GuestAddress(0x1000))
        .unwrap();
    for (index, descriptor) in [0u64, 0x00cf_9b00_0000_ffff, 0x00cf_9300_0000_ffff]
        .into_iter()
        .enumerate()
    {
        kernel
            .ram
            .write_obj(descriptor, GuestAddress(0x500 + index as u64 * 8))
            .unwrap();
    }
    let vm = KvmVm::new().unwrap();
    let region = MemoryRegion {
        guest_addr: 0,
        host_addr: NonNull::new(kernel.ram.get_host_address(GuestAddress(0)).unwrap()).unwrap(),
        size: 128 * 1024 * 1024,
    };
    // SAFETY: the allocation outlives VM and vCPU, even during unwinding.
    // Host RAM access uses vm-memory, and no host accesses it while KVM runs.
    unsafe { vm.map_memory(&region) }.unwrap();
    let mut vcpu = vm.create_vcpu(0).unwrap();
    vcpu.set_cpu_features(vm.supported_cpuid(), &[]).unwrap();
    vcpu.set_boot_registers(&X86BootRegisters {
        rip: 0x1000,
        rsp: 0x8000,
        rflags: 2,
        cr0: 1, // Protected mode with paging disabled: linear address == GPA.
        code: X86Segment {
            limit: u32::MAX,
            selector: 8,
            attributes: 0xc09b,
            ..Default::default()
        },
        data: X86Segment {
            limit: u32::MAX,
            selector: 16,
            attributes: 0xc093,
            ..Default::default()
        },
        gdt_base: 0x500,
        gdt_limit: 23,
        ..Default::default()
    })
    .unwrap();
    let mut observed = None;
    for _ in 0..16 {
        match vcpu.run().unwrap() {
            VcpuExit::Interrupted => continue,
            VcpuExit::IoOut { port, bytes } => {
                assert_eq!(port, 0x500);
                observed = Some(u32::from_le_bytes(bytes.try_into().expect("32-bit OUT")));
                break;
            }
            exit => panic!("unexpected probe exit: {exit:?}"),
        }
    }
    assert_eq!(observed, Some(expected_checksum));
    vcpu.complete_pending_io().unwrap();
    println!(
        "Loaded {segment_count} ELF segments; entry={:#x}, end={:#x}; KVM checksum={expected_checksum:#x}; Linux entry not executed",
        kernel.entry, kernel.kernel_end
    );
}
