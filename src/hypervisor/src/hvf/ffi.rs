// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The Hypervisor.framework calls the backend makes, as the macOS SDK headers
//! declare them: `hv_vm.h`, `hv_vcpu.h`, `hv_vcpu_types.h`, `hv_types.h`,
//! `hv_error.h`, `hv_gic.h`, `hv_gic_config.h` and `hv_gic_parameters.h`.

#![expect(
    non_camel_case_types,
    reason = "The types keep their C names from the SDK headers."
)]

use std::{
    ffi::{CStr, c_char, c_void},
    io, mem,
    sync::OnceLock,
};

/// `mach_error_t`, an `int`.
pub(super) type hv_return_t = i32;
pub(super) type hv_vcpu_t = u64;
pub(super) type hv_ipa_t = u64;
/// An OS object, released with [`os_release`].
pub(super) type hv_gic_config_t = *mut c_void;

pub(super) const HV_SUCCESS: hv_return_t = 0;
pub(super) const HV_ERROR: hv_return_t = 0xfae9_4001_u32 as i32;
pub(super) const HV_BUSY: hv_return_t = 0xfae9_4002_u32 as i32;
pub(super) const HV_BAD_ARGUMENT: hv_return_t = 0xfae9_4003_u32 as i32;
pub(super) const HV_NO_RESOURCES: hv_return_t = 0xfae9_4005_u32 as i32;
pub(super) const HV_NO_DEVICE: hv_return_t = 0xfae9_4006_u32 as i32;
pub(super) const HV_DENIED: hv_return_t = 0xfae9_4007_u32 as i32;
pub(super) const HV_FAULT: hv_return_t = 0xfae9_4008_u32 as i32;
pub(super) const HV_UNSUPPORTED: hv_return_t = 0xfae9_400f_u32 as i32;

/// `hv_exit_reason_t`.
pub(super) const HV_EXIT_REASON_CANCELED: u32 = 0;
pub(super) const HV_EXIT_REASON_EXCEPTION: u32 = 1;

#[repr(C)]
pub(super) struct hv_vcpu_exit_exception_t {
    /// `ESR_EL2`.
    pub(super) syndrome: u64,
    /// `FAR_EL2`.
    pub(super) virtual_address: u64,
    pub(super) physical_address: hv_ipa_t,
}

#[repr(C)]
pub(super) struct hv_vcpu_exit_t {
    pub(super) reason: u32,
    pub(super) exception: hv_vcpu_exit_exception_t,
}

/// `hv_reg_t`: X0 to X30 are 0 to 30, so register 31 is PC, not XZR.
pub(super) const HV_REG_X0: u32 = 0;
pub(super) const HV_REG_PC: u32 = 31;
pub(super) const HV_REG_CPSR: u32 = 34;

/// `hv_sys_reg_t`.
pub(super) const HV_SYS_REG_MPIDR_EL1: u16 = 0xc005;

/// `hv_memory_flags_t`.
pub(super) const HV_MEMORY_READ: u64 = 1 << 0;
pub(super) const HV_MEMORY_WRITE: u64 = 1 << 1;
pub(super) const HV_MEMORY_EXEC: u64 = 1 << 2;

#[link(name = "Hypervisor", kind = "framework")]
unsafe extern "C" {
    pub(super) fn hv_vm_create(config: *mut c_void) -> hv_return_t;
    pub(super) fn hv_vm_destroy() -> hv_return_t;
    pub(super) fn hv_vm_map(
        addr: *mut c_void,
        ipa: hv_ipa_t,
        size: usize,
        flags: u64,
    ) -> hv_return_t;
    pub(super) fn hv_vm_unmap(ipa: hv_ipa_t, size: usize) -> hv_return_t;

    pub(super) fn hv_vcpu_create(
        vcpu: *mut hv_vcpu_t,
        exit: *mut *const hv_vcpu_exit_t,
        config: *mut c_void,
    ) -> hv_return_t;
    pub(super) fn hv_vcpu_destroy(vcpu: hv_vcpu_t) -> hv_return_t;
    pub(super) fn hv_vcpu_run(vcpu: hv_vcpu_t) -> hv_return_t;
    pub(super) fn hv_vcpus_exit(vcpus: *const hv_vcpu_t, vcpu_count: u32) -> hv_return_t;
    pub(super) fn hv_vcpu_get_reg(vcpu: hv_vcpu_t, reg: u32, value: *mut u64) -> hv_return_t;
    pub(super) fn hv_vcpu_set_reg(vcpu: hv_vcpu_t, reg: u32, value: u64) -> hv_return_t;
    pub(super) fn hv_vcpu_set_sys_reg(vcpu: hv_vcpu_t, reg: u16, value: u64) -> hv_return_t;
}

/// The in-kernel GIC calls, new in macOS 15. They are looked up at run time,
/// as libkrun does, never imported: a build for macOS 12 or later binds every
/// import at launch, so one would stop the binary starting on macOS 12 to 14.
#[derive(Debug)]
pub(super) struct GicCalls {
    pub(super) config_create: unsafe extern "C" fn() -> hv_gic_config_t,
    pub(super) config_set_distributor_base:
        unsafe extern "C" fn(hv_gic_config_t, hv_ipa_t) -> hv_return_t,
    pub(super) config_set_redistributor_base:
        unsafe extern "C" fn(hv_gic_config_t, hv_ipa_t) -> hv_return_t,
    pub(super) create: unsafe extern "C" fn(hv_gic_config_t) -> hv_return_t,
    pub(super) get_distributor_size: unsafe extern "C" fn(*mut usize) -> hv_return_t,
    pub(super) get_distributor_base_alignment: unsafe extern "C" fn(*mut usize) -> hv_return_t,
    pub(super) get_redistributor_region_size: unsafe extern "C" fn(*mut usize) -> hv_return_t,
    pub(super) get_redistributor_base_alignment: unsafe extern "C" fn(*mut usize) -> hv_return_t,
    pub(super) set_spi: unsafe extern "C" fn(u32, bool) -> hv_return_t,
}

impl GicCalls {
    /// The calls, looked up once per process. Before macOS 15 this fails with
    /// `Unsupported`, naming the first call missing.
    pub(super) fn get() -> io::Result<&'static Self> {
        static CALLS: OnceLock<Result<GicCalls, &'static CStr>> = OnceLock::new();
        CALLS
            .get_or_init(Self::look_up)
            .as_ref()
            .map_err(|missing| {
                io::Error::new(
                    io::ErrorKind::Unsupported,
                    format!(
                        "Hypervisor.framework has no {}; its in-kernel GIC needs macOS 15",
                        missing.to_string_lossy()
                    ),
                )
            })
    }

    fn look_up() -> Result<Self, &'static CStr> {
        // SAFETY: each field's type is its call's declaration in `hv_gic.h`
        // or `hv_gic_config.h`.
        unsafe {
            Ok(Self {
                config_create: find(c"hv_gic_config_create")?,
                config_set_distributor_base: find(c"hv_gic_config_set_distributor_base")?,
                config_set_redistributor_base: find(c"hv_gic_config_set_redistributor_base")?,
                create: find(c"hv_gic_create")?,
                get_distributor_size: find(c"hv_gic_get_distributor_size")?,
                get_distributor_base_alignment: find(c"hv_gic_get_distributor_base_alignment")?,
                get_redistributor_region_size: find(c"hv_gic_get_redistributor_region_size")?,
                get_redistributor_base_alignment: find(c"hv_gic_get_redistributor_base_alignment")?,
                set_spi: find(c"hv_gic_set_spi")?,
            })
        }
    }
}

/// Looks call `name` up in the loaded images as `F`, or returns `name` when
/// none has it.
///
/// # Safety
///
/// `F` must be the function-pointer type of the call's C declaration.
unsafe fn find<F: Copy>(name: &'static CStr) -> Result<F, &'static CStr> {
    const { assert!(mem::size_of::<F>() == mem::size_of::<*mut c_void>()) };
    // SAFETY: the lookup only reads the NUL-terminated name.
    let address = unsafe { dlsym(RTLD_DEFAULT, name.as_ptr()) };
    if address.is_null() {
        return Err(name);
    }
    // SAFETY: the caller names the call's type, whose size matches.
    Ok(unsafe { mem::transmute_copy(&address) })
}

/// `RTLD_DEFAULT` (`dlfcn.h`): search every image the process has loaded.
const RTLD_DEFAULT: *mut c_void = -2_isize as *mut c_void;

unsafe extern "C" {
    /// Releases an OS object such as an `hv_gic_config_t` (`os/object.h`).
    pub(super) fn os_release(object: *mut c_void);
    /// Finds a loaded symbol by name, or returns null (`dlfcn.h`).
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}
