// Copyright 2025 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Seccomp BPF filter management for VMM process isolation.
//!
//! This module provides build-time compiled seccomp filters for syscall
//! restriction. Filters are defined in JSON format and compiled to BPF
//! bytecode at build time for zero runtime overhead.
//!
//! ## Architecture
//!
//! - JSON filter definitions in `resources/seccomp/*.json`
//! - Build-time compilation to BPF bytecode (via build.rs)
//! - Runtime deserialization and application
//! - Thread-specific filters: vmm, vcpu, api
//!
//! ## Filter Application
//!
//! - VMM filter: Applied to shim main thread before VM takeover
//! - vCPU filter: Compiled but not yet applied (requires libkrun hooks)
//! - API filter: Not used in BoxLite (no separate API thread)
//!
//! ## Thread Model Differences
//!
//! Unlike typical VMMs (Firecracker, Cloud Hypervisor) that explicitly create
//! vCPU threads, BoxLite uses libkrun's process takeover model where vCPU
//! threads are created internally by libkrun. This means:
//!
//! - Main thread: Becomes VMM thread after `ctx.start_enter()` (vmm filter applied)
//! - vCPU threads: Created by libkrun (currently inherit vmm filter)
//!
//! Future enhancement: Add libkrun hooks to apply vcpu filter to vCPU threads.

use std::collections::HashMap;
use std::io::Read;
use std::sync::Arc;

use bincode::config;
use bincode::config::{Configuration, Fixint, Limit, LittleEndian};

// This byte limit is passed to `bincode` to guard against a potential memory
// allocation DOS caused by binary filters that are too large.
// This limit can be safely determined since the maximum length of a BPF
// filter is 4096 instructions and we have a finite number of threads.
const DESERIALIZATION_BYTES_LIMIT: usize = 100_000;

const BINCODE_CONFIG: Configuration<LittleEndian, Fixint, Limit<DESERIALIZATION_BYTES_LIMIT>> =
    config::standard()
        .with_fixed_int_encoding()
        .with_limit::<DESERIALIZATION_BYTES_LIMIT>()
        .with_little_endian();

/// Each BPF instruction is 8 bytes long and 4 byte aligned.
/// This alignment needs to be satisfied in order for a BPF code to be accepted
/// by the syscalls. Using u64 here is safe as it has same size and even bigger alignment.
pub type BpfInstruction = u64;

/// Program made up of a sequence of BPF instructions.
pub type BpfProgram = Vec<BpfInstruction>;

/// Reference to program made up of a sequence of BPF instructions.
pub type BpfProgramRef<'a> = &'a [BpfInstruction];

/// Type that associates a thread category to a BPF program.
pub type BpfThreadMap = HashMap<String, Arc<BpfProgram>>;

/// Binary filter deserialization errors.
pub type DeserializationError = bincode::error::DecodeError;

/// Retrieve empty seccomp filters (for --no-seccomp mode).
pub fn get_empty_filters() -> BpfThreadMap {
    let mut map = BpfThreadMap::new();
    map.insert("vmm".to_string(), Arc::new(vec![]));
    map.insert("api".to_string(), Arc::new(vec![]));
    map.insert("vcpu".to_string(), Arc::new(vec![]));
    map
}

/// Deserialize binary with BPF filters.
pub fn deserialize_binary<R: Read>(mut reader: R) -> Result<BpfThreadMap, DeserializationError> {
    let result: HashMap<String, _> = bincode::decode_from_std_read(&mut reader, BINCODE_CONFIG)?;

    Ok(result
        .into_iter()
        .map(|(k, v)| (k.to_lowercase(), Arc::new(v)))
        .collect())
}

/// Filter installation errors.
#[derive(Debug, thiserror::Error, displaydoc::Display)]
pub enum InstallationError {
    /// Filter length exceeds the maximum size of 4096 instructions
    FilterTooLarge,
    /// `prctl` syscall failed with error code: {0}
    Prctl(std::io::Error),
}

/// The maximum seccomp-BPF program length allowed by the Linux kernel.
pub const BPF_MAX_LEN: usize = 4096;

/// BPF structure definition for filter array.
/// See /usr/include/linux/filter.h .
#[repr(C)]
#[derive(Debug)]
struct SockFprog {
    len: u16,
    filter: *const BpfInstruction,
}

/// Apply BPF filter to current thread.
///
/// This function installs a seccomp filter on the calling thread. The filter
/// is applied using the SECCOMP_SET_MODE_FILTER operation, which allows the
/// kernel to filter system calls based on the BPF program.
///
/// ## Safety
///
/// This function sets PR_SET_NO_NEW_PRIVS to prevent privilege escalation
/// before installing the seccomp filter. This is a security requirement for
/// unprivileged processes to use seccomp.
///
/// ## Errors
///
/// - `FilterTooLarge`: Filter exceeds kernel's BPF_MAX_LEN limit
/// - `Prctl`: System call failed (check errno for details)
pub fn apply_filter(bpf_filter: BpfProgramRef) -> Result<(), InstallationError> {
    // If the program is empty, don't install the filter.
    if bpf_filter.is_empty() {
        return Ok(());
    }

    // If the program length is greater than the limit allowed by the kernel,
    // fail quickly. Otherwise, `prctl` will give a more cryptic error code.
    if BPF_MAX_LEN < bpf_filter.len() {
        return Err(InstallationError::FilterTooLarge);
    }

    let bpf_filter_len =
        u16::try_from(bpf_filter.len()).map_err(|_| InstallationError::FilterTooLarge)?;

    // SAFETY: Safe because the parameters are valid.
    unsafe {
        // Set PR_SET_NO_NEW_PRIVS to prevent privilege escalation
        {
            let rc = libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0);
            if rc != 0 {
                return Err(InstallationError::Prctl(std::io::Error::last_os_error()));
            }
        }

        // Install seccomp filter
        let bpf_prog = SockFprog {
            len: bpf_filter_len,
            filter: bpf_filter.as_ptr(),
        };
        let bpf_prog_ptr = &bpf_prog as *const SockFprog;
        {
            let rc = libc::syscall(
                libc::SYS_seccomp,
                libc::SECCOMP_SET_MODE_FILTER,
                0,
                bpf_prog_ptr,
            );
            if rc != 0 {
                return Err(InstallationError::Prctl(std::io::Error::last_os_error()));
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::undocumented_unsafe_blocks)]

    use std::collections::HashMap;
    use std::sync::Arc;
    use std::thread;

    use super::*;

    #[test]
    fn test_deserialize_binary() {
        // Malformed bincode binary.
        let data = "invalid data".to_string();
        deserialize_binary(data.as_bytes()).unwrap_err();

        // Test that the binary deserialization is correct, and that the thread keys
        // have been lowercased.
        let bpf_prog = vec![0; 2];
        let mut filter_map: HashMap<String, BpfProgram> = HashMap::new();
        filter_map.insert("VcpU".to_string(), bpf_prog.clone());
        let bytes = bincode::encode_to_vec(&filter_map, BINCODE_CONFIG).unwrap();

        let mut expected_res = BpfThreadMap::new();
        expected_res.insert("vcpu".to_string(), Arc::new(bpf_prog));
        assert_eq!(deserialize_binary(&bytes[..]).unwrap(), expected_res);

        // Test oversized filter is rejected
        let bpf_prog = vec![0; DESERIALIZATION_BYTES_LIMIT + 1];
        let mut filter_map: HashMap<String, BpfProgram> = HashMap::new();
        filter_map.insert("VcpU".to_string(), bpf_prog.clone());
        let bytes = bincode::encode_to_vec(&filter_map, BINCODE_CONFIG).unwrap();
        assert!(matches!(
            deserialize_binary(&bytes[..]).unwrap_err(),
            bincode::error::DecodeError::LimitExceeded
        ));
    }

    #[test]
    fn test_filter_apply() {
        // Test filter too large.
        thread::spawn(|| {
            let filter: BpfProgram = vec![0; 5000];

            // Apply seccomp filter.
            assert!(matches!(
                apply_filter(&filter).unwrap_err(),
                InstallationError::FilterTooLarge
            ));
        })
        .join()
        .unwrap();

        // Test empty filter.
        thread::spawn(|| {
            let filter: BpfProgram = vec![];

            assert_eq!(filter.len(), 0);

            let seccomp_level = unsafe { libc::prctl(libc::PR_GET_SECCOMP) };
            assert_eq!(seccomp_level, 0);

            apply_filter(&filter).unwrap();

            // Test that seccomp level remains 0 when no filter applied.
            let seccomp_level = unsafe { libc::prctl(libc::PR_GET_SECCOMP) };
            assert_eq!(seccomp_level, 0);
        })
        .join()
        .unwrap();

        // Test invalid BPF code.
        thread::spawn(|| {
            let filter = vec![0xFF; 1];

            let seccomp_level = unsafe { libc::prctl(libc::PR_GET_SECCOMP) };
            assert_eq!(seccomp_level, 0);

            assert!(matches!(
                apply_filter(&filter).unwrap_err(),
                InstallationError::Prctl(_)
            ));

            // Test that seccomp level remains 0 on failure.
            let seccomp_level = unsafe { libc::prctl(libc::PR_GET_SECCOMP) };
            assert_eq!(seccomp_level, 0);
        })
        .join()
        .unwrap();
    }

    #[test]
    fn test_get_empty_filters() {
        let filters = get_empty_filters();
        assert_eq!(filters.len(), 3);
        assert!(filters.get("vmm").unwrap().is_empty());
        assert!(filters.get("vcpu").unwrap().is_empty());
        assert!(filters.get("api").unwrap().is_empty());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn test_deserialize_embedded_filter() {
        // This test verifies the embedded filter compiled at build time
        let bytes = include_bytes!(concat!(env!("OUT_DIR"), "/seccomp_filter.bpf"));
        let filters = deserialize_binary(&bytes[..]).expect("Failed to deserialize filter");

        // Verify expected thread categories
        assert!(filters.contains_key("vmm"), "Missing vmm filter");
        assert!(filters.contains_key("vcpu"), "Missing vcpu filter");
        assert!(filters.contains_key("api"), "Missing api filter");

        // Verify filters are non-empty (actual filters should have instructions)
        assert!(
            !filters.get("vmm").unwrap().is_empty(),
            "vmm filter is empty"
        );
        assert!(
            !filters.get("vcpu").unwrap().is_empty(),
            "vcpu filter is empty"
        );
    }
}
