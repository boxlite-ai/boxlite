//! Guest binary pre-flight validation.
//!
//! Validates that the packaged `boxlite-guest` is a valid, runnable ELF before
//! the VMM is configured. Catches architecture
//! mismatches and broken binaries early with clear error messages.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

/// ELF magic bytes: 0x7f E L F
const ELF_MAGIC: [u8; 4] = [0x7f, 0x45, 0x4c, 0x46];
const ELF64_HEADER_LEN: usize = 64;
const ELF64_PROGRAM_HEADER_LEN: usize = 56;
const MAX_PROGRAM_HEADERS: usize = 128;
const MAX_DYNAMIC_ENTRIES: u64 = 4096;

const ET_EXEC: u16 = 2;
const ET_DYN: u16 = 3;
const EM_X86_64: u16 = 0x3e;
const EM_AARCH64: u16 = 0xb7;

const PT_LOAD: u32 = 1;
const PT_DYNAMIC: u32 = 2;
const PT_INTERP: u32 = 3;
const PF_X: u32 = 1;
const DT_NULL: i64 = 0;
const DT_NEEDED: i64 = 1;

#[derive(Clone, Copy)]
struct ElfHeader {
    entry: u64,
    program_table_offset: u64,
    program_header_count: usize,
}

#[derive(Clone, Copy)]
struct ProgramHeader {
    segment_type: u32,
    flags: u32,
    file_offset: u64,
    virtual_address: u64,
    file_size: u64,
    memory_size: u64,
    alignment: u64,
}

impl ProgramHeader {
    fn parse(bytes: &[u8; ELF64_PROGRAM_HEADER_LEN]) -> Self {
        Self {
            segment_type: u32::from_le_bytes(bytes[0..4].try_into().unwrap()),
            flags: u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
            file_offset: u64::from_le_bytes(bytes[8..16].try_into().unwrap()),
            virtual_address: u64::from_le_bytes(bytes[16..24].try_into().unwrap()),
            file_size: u64::from_le_bytes(bytes[32..40].try_into().unwrap()),
            memory_size: u64::from_le_bytes(bytes[40..48].try_into().unwrap()),
            alignment: u64::from_le_bytes(bytes[48..56].try_into().unwrap()),
        }
    }
}

/// Validate a packaged guest executable without reading the whole binary.
pub fn validate_guest_file(path: &Path) -> BoxliteResult<()> {
    let mut file = std::fs::File::open(path).map_err(|error| {
        BoxliteError::Internal(format!(
            "Failed to open guest binary {}: {error}",
            path.display()
        ))
    })?;
    let file_len = file
        .metadata()
        .map_err(|error| {
            BoxliteError::Internal(format!(
                "Failed to inspect guest binary {}: {error}",
                path.display()
            ))
        })?
        .len();
    validate_guest_reader(&mut file, file_len, path)
}

/// Validate in-memory guest executable contents through the same boundary.
pub fn validate_guest_bytes(data: &[u8], path: &Path) -> BoxliteResult<()> {
    validate_guest_reader(&mut std::io::Cursor::new(data), data.len() as u64, path)
}

fn validate_guest_reader<R: Read + Seek>(
    reader: &mut R,
    file_len: u64,
    path: &Path,
) -> BoxliteResult<()> {
    if file_len < ELF64_HEADER_LEN as u64 {
        return Err(invalid_elf(
            path,
            format!("is too small ({file_len} bytes) — not a valid ELF"),
        ));
    }

    let mut header_bytes = [0_u8; ELF64_HEADER_LEN];
    read_exact_at(reader, 0, &mut header_bytes, path, "ELF header")?;
    let header = validate_elf_header(&header_bytes, path)?;

    let table_len = ELF64_PROGRAM_HEADER_LEN
        .checked_mul(header.program_header_count)
        .map(|length| length as u64)
        .ok_or_else(|| invalid_elf(path, "has an invalid ELF program-header table"))?;
    let table_end = header
        .program_table_offset
        .checked_add(table_len)
        .ok_or_else(|| invalid_elf(path, "has an invalid ELF program-header table"))?;
    if table_end > file_len {
        return Err(invalid_elf(
            path,
            "has a truncated ELF program-header table",
        ));
    }

    let mut program_headers = Vec::with_capacity(header.program_header_count);
    reader
        .seek(SeekFrom::Start(header.program_table_offset))
        .map_err(|error| invalid_elf(path, format!("cannot seek program headers: {error}")))?;
    for _ in 0..header.program_header_count {
        let mut bytes = [0_u8; ELF64_PROGRAM_HEADER_LEN];
        reader
            .read_exact(&mut bytes)
            .map_err(|error| invalid_elf(path, format!("cannot read program headers: {error}")))?;
        program_headers.push(ProgramHeader::parse(&bytes));
    }

    validate_program_headers(reader, file_len, path, header, &program_headers)
}

fn validate_elf_header(bytes: &[u8; ELF64_HEADER_LEN], path: &Path) -> BoxliteResult<ElfHeader> {
    if bytes[..4] != ELF_MAGIC {
        return Err(invalid_elf(
            path,
            "is not a valid ELF file (bad magic bytes)",
        ));
    }
    if bytes[4] != 2 {
        return Err(invalid_elf(
            path,
            format!("is not 64-bit ELF (class={})", bytes[4]),
        ));
    }
    if bytes[5] != 1 {
        return Err(invalid_elf(
            path,
            format!("is not little-endian ELF (encoding={})", bytes[5]),
        ));
    }
    if bytes[6] != 1 || u32::from_le_bytes(bytes[20..24].try_into().unwrap()) != 1 {
        return Err(invalid_elf(path, "has an unsupported ELF version"));
    }

    let executable_type = u16::from_le_bytes(bytes[16..18].try_into().unwrap());
    if executable_type != ET_EXEC && executable_type != ET_DYN {
        return Err(invalid_elf(
            path,
            format!("has unsupported ELF type {executable_type}; expected ET_EXEC or ET_DYN"),
        ));
    }

    let machine = u16::from_le_bytes(bytes[18..20].try_into().unwrap());
    let expected_machine = match std::env::consts::ARCH {
        "x86_64" => EM_X86_64,
        "aarch64" => EM_AARCH64,
        architecture => {
            return Err(invalid_elf(
                path,
                format!("cannot run on unsupported host architecture {architecture}"),
            ));
        }
    };
    if machine != expected_machine {
        let binary_arch = match machine {
            EM_X86_64 => "x86_64",
            EM_AARCH64 => "aarch64",
            _ => "unknown",
        };
        return Err(invalid_elf(
            path,
            format!(
                "is compiled for {binary_arch} but host is {}",
                std::env::consts::ARCH
            ),
        ));
    }

    let header_len = u16::from_le_bytes(bytes[52..54].try_into().unwrap()) as usize;
    if header_len != ELF64_HEADER_LEN {
        return Err(invalid_elf(path, "has an invalid ELF header size"));
    }
    let program_header_len = u16::from_le_bytes(bytes[54..56].try_into().unwrap()) as usize;
    if program_header_len != ELF64_PROGRAM_HEADER_LEN {
        return Err(invalid_elf(path, "has an invalid ELF program-header size"));
    }
    let program_header_count = u16::from_le_bytes(bytes[56..58].try_into().unwrap()) as usize;
    if program_header_count == 0 || program_header_count > MAX_PROGRAM_HEADERS {
        return Err(invalid_elf(path, "has an invalid ELF program-header count"));
    }

    Ok(ElfHeader {
        entry: u64::from_le_bytes(bytes[24..32].try_into().unwrap()),
        program_table_offset: u64::from_le_bytes(bytes[32..40].try_into().unwrap()),
        program_header_count,
    })
}

fn validate_program_headers<R: Read + Seek>(
    reader: &mut R,
    file_len: u64,
    path: &Path,
    elf: ElfHeader,
    program_headers: &[ProgramHeader],
) -> BoxliteResult<()> {
    let mut has_load_segment = false;
    let mut entry_is_executable = false;

    for program in program_headers {
        match program.segment_type {
            PT_LOAD => {
                has_load_segment = true;
                validate_file_range(program, file_len, path, "PT_LOAD")?;
                if program.file_size > program.memory_size {
                    return Err(invalid_elf(
                        path,
                        "has PT_LOAD file size larger than memory size",
                    ));
                }
                if program.alignment > 1
                    && (!program.alignment.is_power_of_two()
                        || program.file_offset % program.alignment
                            != program.virtual_address % program.alignment)
                {
                    return Err(invalid_elf(path, "has invalid PT_LOAD alignment"));
                }
                let memory_end = program
                    .virtual_address
                    .checked_add(program.memory_size)
                    .ok_or_else(|| invalid_elf(path, "has overflowing PT_LOAD memory range"))?;
                if program.flags & PF_X != 0
                    && elf.entry >= program.virtual_address
                    && elf.entry < memory_end
                {
                    entry_is_executable = true;
                }
            }
            PT_INTERP => {
                return Err(invalid_elf(
                    path,
                    "is dynamically linked; the minimal rootfs has no runtime loader",
                ));
            }
            PT_DYNAMIC => validate_dynamic_table(reader, file_len, path, program)?,
            _ => {}
        }
    }

    if !has_load_segment {
        return Err(invalid_elf(path, "has no loadable ELF segment"));
    }
    if !entry_is_executable {
        return Err(invalid_elf(
            path,
            "entry point is not covered by an executable PT_LOAD segment",
        ));
    }
    Ok(())
}

fn validate_file_range(
    program: &ProgramHeader,
    file_len: u64,
    path: &Path,
    segment_name: &str,
) -> BoxliteResult<()> {
    let file_end = program
        .file_offset
        .checked_add(program.file_size)
        .ok_or_else(|| invalid_elf(path, format!("has overflowing {segment_name} file range")))?;
    if file_end > file_len {
        return Err(invalid_elf(
            path,
            format!("has {segment_name} data outside the file"),
        ));
    }
    Ok(())
}

fn validate_dynamic_table<R: Read + Seek>(
    reader: &mut R,
    file_len: u64,
    path: &Path,
    program: &ProgramHeader,
) -> BoxliteResult<()> {
    validate_file_range(program, file_len, path, "PT_DYNAMIC")?;
    if !program.file_size.is_multiple_of(16) || program.file_size / 16 > MAX_DYNAMIC_ENTRIES {
        return Err(invalid_elf(path, "has an invalid PT_DYNAMIC table size"));
    }

    reader
        .seek(SeekFrom::Start(program.file_offset))
        .map_err(|error| invalid_elf(path, format!("cannot seek dynamic table: {error}")))?;
    for _ in 0..program.file_size / 16 {
        let mut entry = [0_u8; 16];
        reader
            .read_exact(&mut entry)
            .map_err(|error| invalid_elf(path, format!("cannot read dynamic table: {error}")))?;
        match i64::from_le_bytes(entry[..8].try_into().unwrap()) {
            DT_NULL => break,
            DT_NEEDED => {
                return Err(invalid_elf(
                    path,
                    "is dynamically linked; the minimal rootfs has no runtime loader",
                ));
            }
            _ => {}
        }
    }
    Ok(())
}

fn read_exact_at<R: Read + Seek>(
    reader: &mut R,
    offset: u64,
    buffer: &mut [u8],
    path: &Path,
    description: &str,
) -> BoxliteResult<()> {
    reader
        .seek(SeekFrom::Start(offset))
        .and_then(|_| reader.read_exact(buffer))
        .map_err(|error| invalid_elf(path, format!("cannot read {description}: {error}")))
}

fn invalid_elf(path: &Path, detail: impl std::fmt::Display) -> BoxliteError {
    BoxliteError::Internal(format!("Guest binary {} {detail}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stand-in for the path these checks only ever name in error messages.
    fn guest_path() -> &'static Path {
        Path::new("/runtime/boxlite-guest")
    }

    /// Create a minimal valid 64-bit little-endian ELF header for testing.
    fn make_elf_header(machine: u16, add_interp: bool) -> Vec<u8> {
        let mut data = vec![0u8; 128];

        // ELF magic + class(64-bit) + data(LE) + version
        data[0..4].copy_from_slice(&ELF_MAGIC);
        data[4] = 2; // 64-bit
        data[5] = 1; // little-endian
        data[6] = 1; // ELF version

        data[16..18].copy_from_slice(&ET_EXEC.to_le_bytes());
        data[18..20].copy_from_slice(&machine.to_le_bytes());
        data[20..24].copy_from_slice(&1_u32.to_le_bytes());
        data[52..54].copy_from_slice(&(ELF64_HEADER_LEN as u16).to_le_bytes());

        if add_interp {
            // e_phoff=64, e_phentsize=56, e_phnum=1
            data[32..40].copy_from_slice(&64u64.to_le_bytes());
            data[54..56].copy_from_slice(&56u16.to_le_bytes());
            data[56..58].copy_from_slice(&1u16.to_le_bytes());
            // Program header at offset 64: p_type = PT_INTERP
            data[64..68].copy_from_slice(&PT_INTERP.to_le_bytes());
        }

        data
    }

    fn make_loadable_elf(machine: u16) -> Vec<u8> {
        let mut data = make_elf_header(machine, false);
        data[16..18].copy_from_slice(&2_u16.to_le_bytes());
        data[20..24].copy_from_slice(&1_u32.to_le_bytes());
        data[24..32].copy_from_slice(&0x400040_u64.to_le_bytes());
        data[32..40].copy_from_slice(&64_u64.to_le_bytes());
        data[52..54].copy_from_slice(&64_u16.to_le_bytes());
        data[54..56].copy_from_slice(&56_u16.to_le_bytes());
        data[56..58].copy_from_slice(&1_u16.to_le_bytes());
        data[64..68].copy_from_slice(&PT_LOAD.to_le_bytes());
        data[68..72].copy_from_slice(&1_u32.to_le_bytes());
        data[80..88].copy_from_slice(&0x400000_u64.to_le_bytes());
        let file_len = data.len() as u64;
        data[96..104].copy_from_slice(&file_len.to_le_bytes());
        data[104..112].copy_from_slice(&file_len.to_le_bytes());
        data
    }

    #[test]
    fn test_valid_binary_matching_arch() {
        let machine = match std::env::consts::ARCH {
            "x86_64" => EM_X86_64,
            "aarch64" => EM_AARCH64,
            _ => return,
        };

        assert!(validate_guest_bytes(&make_loadable_elf(machine), guest_path()).is_ok());
    }

    #[test]
    fn test_wrong_elf_type_is_rejected() {
        let machine = match std::env::consts::ARCH {
            "x86_64" => EM_X86_64,
            "aarch64" => EM_AARCH64,
            _ => return,
        };
        let mut binary = make_loadable_elf(machine);
        binary[16..18].copy_from_slice(&1_u16.to_le_bytes());
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("boxlite-guest");
        std::fs::write(&path, binary).unwrap();

        let error = validate_guest_file(&path).unwrap_err();
        assert!(error.to_string().contains("ELF type"));
    }

    #[test]
    fn test_out_of_file_load_segment_is_rejected() {
        let machine = match std::env::consts::ARCH {
            "x86_64" => EM_X86_64,
            "aarch64" => EM_AARCH64,
            _ => return,
        };
        let mut binary = make_loadable_elf(machine);
        binary[96..104].copy_from_slice(&u64::MAX.to_le_bytes());
        binary[104..112].copy_from_slice(&u64::MAX.to_le_bytes());
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("boxlite-guest");
        std::fs::write(&path, binary).unwrap();

        let error = validate_guest_file(&path).unwrap_err();
        assert!(error.to_string().contains("PT_LOAD"));
    }

    #[test]
    fn test_dt_needed_is_rejected_without_pt_interp() {
        let machine = match std::env::consts::ARCH {
            "x86_64" => EM_X86_64,
            "aarch64" => EM_AARCH64,
            _ => return,
        };
        let mut binary = make_loadable_elf(machine);
        binary.resize(208, 0);
        binary[56..58].copy_from_slice(&2_u16.to_le_bytes());
        let file_len = binary.len() as u64;
        binary[96..104].copy_from_slice(&file_len.to_le_bytes());
        binary[104..112].copy_from_slice(&file_len.to_le_bytes());
        binary[120..124].copy_from_slice(&2_u32.to_le_bytes());
        binary[128..136].copy_from_slice(&176_u64.to_le_bytes());
        binary[136..144].copy_from_slice(&0x4000b0_u64.to_le_bytes());
        binary[152..160].copy_from_slice(&32_u64.to_le_bytes());
        binary[160..168].copy_from_slice(&32_u64.to_le_bytes());
        binary[176..184].copy_from_slice(&1_i64.to_le_bytes());
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("boxlite-guest");
        std::fs::write(&path, binary).unwrap();

        let error = validate_guest_file(&path).unwrap_err();
        assert!(error.to_string().contains("dynamically linked"));
    }

    #[test]
    fn test_wrong_arch() {
        let machine = match std::env::consts::ARCH {
            "x86_64" => EM_AARCH64,
            "aarch64" => EM_X86_64,
            _ => return,
        };

        let err = validate_guest_bytes(&make_elf_header(machine, false), guest_path()).unwrap_err();
        assert!(err.to_string().contains("compiled for"));
        assert!(err.to_string().contains("but host is"));
    }

    #[test]
    fn test_not_elf() {
        let err = validate_guest_bytes(
            b"not an elf file at all, but long enough to reach the magic check",
            guest_path(),
        )
        .unwrap_err();
        assert!(err.to_string().contains("not a valid ELF"));
    }

    #[test]
    fn test_too_small() {
        let err = validate_guest_bytes(b"tiny", guest_path()).unwrap_err();
        assert!(err.to_string().contains("too small"));
    }

    #[test]
    fn test_32bit_elf() {
        let mut data = vec![0u8; 64];
        data[0..4].copy_from_slice(&ELF_MAGIC);
        data[4] = 1; // 32-bit class

        let err = validate_guest_bytes(&data, guest_path()).unwrap_err();
        assert!(err.to_string().contains("not 64-bit"));
    }

    #[test]
    fn test_guest_file_rejects_malformed_program_header_offset_without_panicking() {
        let machine = match std::env::consts::ARCH {
            "x86_64" => EM_X86_64,
            "aarch64" => EM_AARCH64,
            _ => return,
        };
        let mut binary = make_elf_header(machine, false);
        binary[32..40].copy_from_slice(&u64::MAX.to_le_bytes());
        binary[54..56].copy_from_slice(&(ELF64_PROGRAM_HEADER_LEN as u16).to_le_bytes());
        binary[56..58].copy_from_slice(&1_u16.to_le_bytes());
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("boxlite-guest");
        std::fs::write(&path, binary).unwrap();

        let error = validate_guest_file(&path).unwrap_err();
        assert!(error.to_string().contains("program-header table"));
    }

    #[test]
    fn test_guest_file_checks_program_headers() {
        let machine = match std::env::consts::ARCH {
            "x86_64" => EM_X86_64,
            "aarch64" => EM_AARCH64,
            _ => return,
        };
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("boxlite-guest");
        std::fs::write(&path, make_elf_header(machine, true)).unwrap();

        let error = validate_guest_file(&path).unwrap_err();
        assert!(error.to_string().contains("dynamically linked"));
    }

    #[test]
    fn test_dynamically_linked_binary_is_rejected() {
        let machine = match std::env::consts::ARCH {
            "x86_64" => EM_X86_64,
            "aarch64" => EM_AARCH64,
            _ => return,
        };

        let error =
            validate_guest_bytes(&make_elf_header(machine, true), guest_path()).unwrap_err();
        assert!(error.to_string().contains("dynamically linked"));
    }
}
