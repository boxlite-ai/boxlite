//! The M1 smoke initramfs: a static `/init` that prints a marker on the
//! console and restarts the machine. A copy of the VMM crate's private boot
//! test helpers (`src/vmm/tests/boot/mod.rs`); the two crates cannot share
//! test code without a dependency cycle.

/// The line `/init` prints before it restarts the guest.
pub(super) const M1_MARKER: &str = "BOXLITE_M1_OK";

const PROGRAM_BASE: u64 = 0x40_0000;
const PROGRAM_HEADERS: u64 = 64 + 56;

/// An uncompressed newc archive whose only file is the M1 `/init`.
pub(super) fn m1_archive() -> Vec<u8> {
    newc_archive("init", &print_and_restart(M1_MARKER))
}

/// A static x86_64 executable: one read-only, executable `PT_LOAD` at
/// `PROGRAM_BASE` holding the headers and then `text`, its entry point.
fn static_program(text: &[u8]) -> Vec<u8> {
    let size = PROGRAM_HEADERS + text.len() as u64;
    let mut elf = vec![0x7f, b'E', b'L', b'F', 2, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    elf.extend_from_slice(&2u16.to_le_bytes()); // ET_EXEC
    elf.extend_from_slice(&62u16.to_le_bytes()); // EM_X86_64
    elf.extend_from_slice(&1u32.to_le_bytes()); // EV_CURRENT
    elf.extend_from_slice(&(PROGRAM_BASE + PROGRAM_HEADERS).to_le_bytes()); // entry
    elf.extend_from_slice(&64u64.to_le_bytes()); // program headers
    elf.extend_from_slice(&0u64.to_le_bytes()); // no section headers
    elf.extend_from_slice(&0u32.to_le_bytes()); // flags
    for half in [64u16, 56, 1, 0, 0, 0] {
        // header size, program header size and count, no sections
        elf.extend_from_slice(&half.to_le_bytes());
    }
    elf.extend_from_slice(&1u32.to_le_bytes()); // PT_LOAD
    elf.extend_from_slice(&5u32.to_le_bytes()); // R and X
    for word in [0, PROGRAM_BASE, PROGRAM_BASE, size, size, 0x1000] {
        // offset, virtual and physical address, file and memory size, alignment
        elf.extend_from_slice(&word.to_le_bytes());
    }
    elf.extend_from_slice(text);
    elf
}

/// A static executable that writes `line` and a newline to its stdout, waits
/// until the tty has sent them, and restarts the machine; `exit_group(1)`
/// follows in case the restart returns.
fn print_and_restart(line: &str) -> Vec<u8> {
    const CODE_LEN: u64 = 81;
    let message = format!("{line}\n");
    let message_addr = u32::try_from(PROGRAM_BASE + PROGRAM_HEADERS + CODE_LEN).unwrap();
    let message_len = u32::try_from(message.len()).unwrap();
    let mut text = Vec::new();
    // mov eax, 1 (write); mov edi, 1; mov esi, message; mov edx, length; syscall
    text.extend_from_slice(&[0xb8, 1, 0, 0, 0, 0xbf, 1, 0, 0, 0, 0xbe]);
    text.extend_from_slice(&message_addr.to_le_bytes());
    text.push(0xba);
    text.extend_from_slice(&message_len.to_le_bytes());
    text.extend_from_slice(&[0x0f, 0x05]);
    // mov eax, 16 (ioctl); mov edi, 1; mov esi, 0x5409 (TCSBRK); mov edx, 1
    // (drain, no break); syscall
    text.extend_from_slice(&[
        0xb8, 16, 0, 0, 0, 0xbf, 1, 0, 0, 0, 0xbe, 0x09, 0x54, 0, 0, 0xba, 1, 0, 0, 0, 0x0f, 0x05,
    ]);
    // mov eax, 169 (reboot); mov edi, 0xfee1dead; mov esi, 0x28121969;
    // mov edx, 0x01234567 (LINUX_REBOOT_CMD_RESTART); xor r10d, r10d; syscall
    text.extend_from_slice(&[
        0xb8, 169, 0, 0, 0, 0xbf, 0xad, 0xde, 0xe1, 0xfe, 0xbe, 0x69, 0x19, 0x12, 0x28, 0xba, 0x67,
        0x45, 0x23, 0x01, 0x45, 0x31, 0xd2, 0x0f, 0x05,
    ]);
    // mov edi, 1; mov eax, 231 (exit_group); syscall
    text.extend_from_slice(&[0xbf, 1, 0, 0, 0, 0xb8, 231, 0, 0, 0, 0x0f, 0x05]);
    assert_eq!(text.len() as u64, CODE_LEN);
    text.extend_from_slice(message.as_bytes());
    static_program(&text)
}

/// An uncompressed newc archive holding one executable file, `name`
/// (`Documentation/driver-api/early-userspace/buffer-format.rst`).
fn newc_archive(name: &str, data: &[u8]) -> Vec<u8> {
    fn entry(archive: &mut Vec<u8>, ino: u32, mode: u32, name: &str, data: &[u8]) {
        let fields = [
            ino,
            mode,
            0,
            0,
            1,
            0,
            data.len() as u32,
            0,
            0,
            0,
            0,
            name.len() as u32 + 1,
            0,
        ];
        archive.extend_from_slice(b"070701");
        for field in fields {
            archive.extend_from_slice(format!("{field:08X}").as_bytes());
        }
        archive.extend_from_slice(name.as_bytes());
        archive.push(0);
        archive.resize(archive.len().next_multiple_of(4), 0);
        archive.extend_from_slice(data);
        archive.resize(archive.len().next_multiple_of(4), 0);
    }

    let mut archive = Vec::new();
    entry(&mut archive, 1, 0o100_755, name, data);
    entry(&mut archive, 0, 0, "TRAILER!!!", &[]);
    archive
}
