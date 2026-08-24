//! Guest artifact pre-flight validation.
//!
//! Validates that a guest artifact (`boxlite-guest`, or the static
//! `mke2fs`/`resize2fs` tools) is a valid, runnable ELF before it gets injected
//! into the guest rootfs ext4 image. Catches architecture mismatches and broken
//! binaries early with clear error messages.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use std::path::Path;

/// ELF magic bytes: 0x7f 'E' 'L' 'F'
const ELF_MAGIC: [u8; 4] = [0x7f, b'E', b'L', b'F'];

/// ELF e_machine values for supported architectures.
const EM_X86_64: u16 = 0x3E;
const EM_AARCH64: u16 = 0xB7;

/// ELF program header type for interpreter (PT_INTERP).
const PT_INTERP: u32 = 3;

/// Size of a single ELF64 program header entry (sizeof(Elf64_Phdr)).
const ELF64_PHDR_SIZE: usize = 56;

/// Validate that guest artifact contents are a runnable ELF for this host.
///
/// Checks:
/// 1. Non-empty and large enough to hold an ELF header
/// 2. Valid ELF magic bytes
/// 3. Machine type matches host architecture
/// 4. Binary is statically linked (no PT_INTERP program header)
///
/// Takes bytes rather than a path because the callers
/// ([`GuestBinary`](crate::vmm::guest_binary::GuestBinary) and
/// [`GuestArtifacts`](crate::vmm::guest_artifacts::GuestArtifacts)) have already
/// read the file to digest it; reading it a second time to validate is waste.
/// `path` names the artifact in error messages only.
pub fn validate_guest_bytes(data: &[u8], path: &Path) -> BoxliteResult<()> {
    if data.len() < 64 {
        return Err(BoxliteError::Internal(format!(
            "Guest artifact {} is too small ({} bytes) — not a valid ELF",
            path.display(),
            data.len()
        )));
    }

    if data[..4] != ELF_MAGIC {
        return Err(BoxliteError::Internal(format!(
            "Guest artifact {} is not a valid ELF file (bad magic bytes)",
            path.display()
        )));
    }

    if data[4] != 2 {
        return Err(BoxliteError::Internal(format!(
            "Guest artifact {} is not 64-bit ELF (class={})",
            path.display(),
            data[4]
        )));
    }

    // e_machine at bytes 18-19 (LE — both x86_64 and aarch64 are little-endian)
    let e_machine = u16::from_le_bytes(data[18..20].try_into().unwrap());

    let expected_machine = match std::env::consts::ARCH {
        "x86_64" => EM_X86_64,
        "aarch64" => EM_AARCH64,
        arch => {
            tracing::warn!(
                arch,
                "Cannot validate guest artifact architecture — unknown host arch"
            );
            return Ok(());
        }
    };

    if e_machine != expected_machine {
        let binary_arch = match e_machine {
            EM_X86_64 => "x86_64",
            EM_AARCH64 => "aarch64",
            _ => "unknown",
        };
        return Err(BoxliteError::Internal(format!(
            "Guest artifact {} is compiled for {} but host is {}\n\
             Rebuild the guest artifact for the correct target",
            path.display(),
            binary_arch,
            std::env::consts::ARCH,
        )));
    }

    if has_pt_interp(data)? {
        return Err(BoxliteError::Internal(format!(
            "Guest artifact {} is dynamically linked (has a PT_INTERP program header) — \
             the minimal rootfs has no dynamic loader; rebuild the artifact statically",
            path.display()
        )));
    }

    Ok(())
}

/// Check if an ELF binary has a PT_INTERP program header (dynamically linked).
///
/// Returns `Err` on a malformed program-header table (offset arithmetic that
/// overflows or runs past the end of `data`) rather than panicking.
fn has_pt_interp(data: &[u8]) -> BoxliteResult<bool> {
    if data.len() < 64 {
        return Ok(false);
    }

    // 64-bit ELF header (LE): e_phoff at 32, e_phentsize at 54, e_phnum at 56
    let e_phoff = u64::from_le_bytes(data[32..40].try_into().unwrap()) as usize;
    let e_phentsize = u16::from_le_bytes(data[54..56].try_into().unwrap()) as usize;
    let e_phnum = u16::from_le_bytes(data[56..58].try_into().unwrap()) as usize;

    // A program header table with a zero or otherwise wrong entry size is
    // malformed; the kernel rejects such an ELF at exec time. Reject it here
    // rather than silently scanning with a bogus stride.
    if e_phnum != 0 && e_phentsize != ELF64_PHDR_SIZE {
        return Err(BoxliteError::Internal(format!(
            "guest ELF program header entry size {e_phentsize} is invalid (expected {ELF64_PHDR_SIZE})"
        )));
    }

    for i in 0..e_phnum {
        let ph_offset = i
            .checked_mul(e_phentsize)
            .and_then(|offset| e_phoff.checked_add(offset))
            .ok_or_else(|| {
                BoxliteError::Internal("guest ELF program header offset overflow".into())
            })?;
        // The kernel reads the whole e_phentsize-byte entry, so bounds-check
        // the full entry rather than only the leading p_type field.
        let ph_end = ph_offset.checked_add(e_phentsize).ok_or_else(|| {
            BoxliteError::Internal("guest ELF program header offset overflow".into())
        })?;
        if ph_end > data.len() {
            return Err(BoxliteError::Internal(
                "guest ELF program header table runs past end of file".into(),
            ));
        }
        // p_type is the entry's first 4 bytes; the full entry already fits, so
        // this slice is within bounds.
        let p_type = u32::from_le_bytes(data[ph_offset..ph_offset + 4].try_into().unwrap());
        if p_type == PT_INTERP {
            return Ok(true);
        }
    }

    Ok(false)
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

        // e_machine at offset 18
        data[18..20].copy_from_slice(&machine.to_le_bytes());

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

    #[test]
    fn test_valid_binary_matching_arch() {
        let machine = match std::env::consts::ARCH {
            "x86_64" => EM_X86_64,
            "aarch64" => EM_AARCH64,
            _ => return,
        };

        assert!(validate_guest_bytes(&make_elf_header(machine, false), guest_path()).is_ok());
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
    fn test_has_pt_interp_detection() {
        assert!(has_pt_interp(&make_elf_header(EM_X86_64, true)).unwrap());
        assert!(!has_pt_interp(&make_elf_header(EM_X86_64, false)).unwrap());
    }

    #[test]
    fn test_dynamically_linked_binary_rejected() {
        let machine = match std::env::consts::ARCH {
            "x86_64" => EM_X86_64,
            "aarch64" => EM_AARCH64,
            _ => return,
        };

        let err = validate_guest_bytes(&make_elf_header(machine, true), guest_path()).unwrap_err();
        assert!(err.to_string().contains("dynamically linked"));
    }

    #[test]
    fn test_malformed_phoff_returns_error_not_panic() {
        // e_phoff = usize::MAX overflows the offset arithmetic; parsing must
        // return an error instead of panicking.
        let mut data = make_elf_header(EM_X86_64, true);
        data[32..40].copy_from_slice(&u64::MAX.to_le_bytes());

        let err = has_pt_interp(&data).unwrap_err();
        assert!(err.to_string().contains("program header"));
    }

    #[test]
    fn test_zero_phentsize_with_phnum_rejected() {
        // e_phnum=1 with e_phentsize=0 is a malformed ELF64 header: the kernel
        // rejects it at exec time, so `has_pt_interp` must reject it up front
        // rather than silently scanning with a zero-sized program-header entry.
        let mut data = make_elf_header(EM_X86_64, false);
        data[32..40].copy_from_slice(&64u64.to_le_bytes()); // e_phoff = 64
        data[54..56].copy_from_slice(&0u16.to_le_bytes()); // e_phentsize = 0
        data[56..58].copy_from_slice(&1u16.to_le_bytes()); // e_phnum = 1

        let err = has_pt_interp(&data).unwrap_err();
        assert!(err.to_string().contains("program header entry size"));
    }

    #[test]
    fn test_truncated_program_header_rejected() {
        // e_phoff=64, e_phentsize=56, e_phnum=1 but the file is only 68 bytes:
        // the 56-byte program-header entry (64..120) is truncated. The kernel
        // needs the full entry, so `has_pt_interp` must reject it up front
        // rather than accepting a non-PT_INTERP p_type in the first 4 bytes.
        let mut data = make_elf_header(EM_X86_64, false);
        data[32..40].copy_from_slice(&64u64.to_le_bytes()); // e_phoff = 64
        data[54..56].copy_from_slice(&56u16.to_le_bytes()); // e_phentsize = 56
        data[56..58].copy_from_slice(&1u16.to_le_bytes()); // e_phnum = 1
        // p_type at offset 64 stays zero (non-PT_INTERP).
        data.truncate(68);

        let err = has_pt_interp(&data).unwrap_err();
        assert!(err.to_string().contains("runs past end of file"));
    }
}
