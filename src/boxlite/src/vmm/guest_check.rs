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

    if has_pt_interp(data) {
        tracing::warn!(
            path = %path.display(),
            "Guest artifact is dynamically linked — it may fail inside the VM"
        );
    }

    Ok(())
}

/// Check if an ELF binary has a PT_INTERP program header (dynamically linked).
fn has_pt_interp(data: &[u8]) -> bool {
    if data.len() < 64 {
        return false;
    }

    // 64-bit ELF header (LE): e_phoff at 32, e_phentsize at 54, e_phnum at 56
    let e_phoff = u64::from_le_bytes(data[32..40].try_into().unwrap()) as usize;
    let e_phentsize = u16::from_le_bytes(data[54..56].try_into().unwrap()) as usize;
    let e_phnum = u16::from_le_bytes(data[56..58].try_into().unwrap()) as usize;

    for i in 0..e_phnum {
        let ph_offset = e_phoff + i * e_phentsize;
        if ph_offset + 4 > data.len() {
            break;
        }
        let p_type = u32::from_le_bytes(data[ph_offset..ph_offset + 4].try_into().unwrap());
        if p_type == PT_INTERP {
            return true;
        }
    }

    false
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
        assert!(has_pt_interp(&make_elf_header(EM_X86_64, true)));
        assert!(!has_pt_interp(&make_elf_header(EM_X86_64, false)));
    }

    #[test]
    fn test_dynamically_linked_binary_warns() {
        let machine = match std::env::consts::ARCH {
            "x86_64" => EM_X86_64,
            "aarch64" => EM_AARCH64,
            _ => return,
        };

        // Should still pass (warning only, not error)
        assert!(validate_guest_bytes(&make_elf_header(machine, true), guest_path()).is_ok());
    }
}
