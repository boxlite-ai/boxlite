// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! HVF backend tests. The decoding tests run on any macOS arm64 host. The
//! `#[ignore]`d hardware tests need Hypervisor.framework and a test binary
//! signed with `com.apple.security.hypervisor`, which
//! `make test:integration:vmm:hvf` provides; they take a process-wide lock,
//! since a process holds one VM at a time.
//!
//! The syndromes below are the ones HVF reported for the same instructions on
//! an M5 Pro with macOS 27.0.1 (design #2103).

use std::{
    alloc::{self, Layout},
    ffi::{CStr, c_char, c_void},
    io, mem,
    process::Command,
    ptr::NonNull,
    sync::{Mutex, MutexGuard, PoisonError},
    thread,
    time::{Duration, Instant},
};

use super::{
    HvfVcpu, HvfVm, check,
    psci::{self, PsciCall},
    syndrome::{MmioAccess, Syndrome, SysRegAccess},
};
use crate::{Arm64BootRegisters, CpuOnResult, Error, MemoryRegion, VcpuExit, VcpuHandle};

/// An `ESR_EL2` value with exception class `ec`, a 32-bit instruction and `iss`.
fn esr(ec: u64, iss: u64) -> u64 {
    ec << 26 | 1 << 25 | iss
}

const EC_WFX: u64 = 0x01;
const EC_HVC: u64 = 0x16;
const EC_SMC: u64 = 0x17;
const EC_SYSREG: u64 = 0x18;
const EC_INSTRUCTION_ABORT: u64 = 0x20;
const EC_DATA_ABORT: u64 = 0x24;

fn mmio(len: usize, write: bool, register: u8, sign_extend: bool, sixty_four: bool) -> MmioAccess {
    MmioAccess {
        len,
        write,
        register,
        sign_extend,
        sixty_four,
    }
}

#[test]
fn decodes_the_data_aborts_hvf_reports_for_each_width_and_register() {
    for (iss, access, instruction) in [
        (0x181_0046, mmio(4, true, 1, false, false), "str w1, [x0]"),
        (
            0x182_0006,
            mmio(4, false, 2, false, false),
            "ldr w2, [x0, #4]",
        ),
        (
            0x125_8006,
            mmio(1, false, 5, true, true),
            "ldrsb x5, [x0, #8]",
        ),
        (
            0x1df_8046,
            mmio(8, true, 31, false, true),
            "str xzr, [x0, #16]",
        ),
    ] {
        assert_eq!(
            Syndrome::decode(esr(EC_DATA_ABORT, iss)),
            Syndrome::Mmio(access),
            "{instruction}"
        );
    }
}

#[test]
fn extends_a_read_by_its_sign_and_register_width() {
    let read = |len, sign_extend, sixty_four| mmio(len, false, 5, sign_extend, sixty_four);
    for (access, raw, value, instruction) in [
        (read(1, true, true), 0x80, 0xffff_ffff_ffff_ff80, "ldrsb x"),
        (read(1, true, false), 0x80, 0x0000_0000_ffff_ff80, "ldrsb w"),
        (
            read(2, true, true),
            0x8001,
            0xffff_ffff_ffff_8001,
            "ldrsh x",
        ),
        (
            read(4, true, true),
            0x8000_0000,
            0xffff_ffff_8000_0000,
            "ldrsw x",
        ),
        (read(1, true, true), 0x7f, 0x7f, "ldrsb x, positive"),
        (read(1, false, false), 0x80, 0x80, "ldrb w"),
        (read(4, false, false), 0xffff_ffff, 0xffff_ffff, "ldr w"),
        (read(8, false, true), u64::MAX, u64::MAX, "ldr x"),
    ] {
        assert_eq!(access.extend(raw), value, "{instruction}");
    }
}

#[test]
fn leaves_data_aborts_it_cannot_emulate_unhandled() {
    // ISV clear, as for a load pair, names no register to complete.
    assert!(matches!(
        Syndrome::decode(esr(EC_DATA_ABORT, 0x000_0046)),
        Syndrome::Unhandled(_)
    ));
    // S1PTW: the guest's own page-table walk reached an unbacked address.
    assert!(matches!(
        Syndrome::decode(esr(EC_DATA_ABORT, 0x181_0046 | 1 << 7)),
        Syndrome::Unhandled(_)
    ));
    // Cache maintenance on a device address is skipped, as QEMU does.
    assert_eq!(
        Syndrome::decode(esr(EC_DATA_ABORT, 1 << 8 | 1 << 6)),
        Syndrome::CacheMaintenance
    );
}

#[test]
fn decodes_calls_waits_and_system_register_traps() {
    assert_eq!(Syndrome::decode(esr(EC_HVC, 0)), Syndrome::Hvc);
    assert_eq!(Syndrome::decode(esr(EC_SMC, 0)), Syndrome::Smc);
    assert_eq!(Syndrome::decode(esr(EC_WFX, 0)), Syndrome::Wfx);
    assert_eq!(Syndrome::decode(esr(EC_WFX, 1)), Syndrome::Wfx);
    let sysreg = |op1, crn, crm, op2, register, read| SysRegAccess {
        op0: 2,
        op1,
        crn,
        crm,
        op2,
        register,
        read,
    };
    for (iss, access, instruction) in [
        (
            0x028_07e0,
            sysreg(0, 1, 0, 4, 31, false),
            "msr oslar_el1, xzr",
        ),
        (0x028_0467, sysreg(0, 1, 3, 4, 3, true), "mrs x3, osdlr_el1"),
    ] {
        assert_eq!(
            Syndrome::decode(esr(EC_SYSREG, iss)),
            Syndrome::SysReg(access),
            "{instruction}"
        );
    }
    // A fetch from an address no RAM backs: the guest jumped into a hole.
    assert!(matches!(
        Syndrome::decode(esr(EC_INSTRUCTION_ABORT, 0x6)),
        Syndrome::Unhandled(_)
    ));
}

/// `(op0, op1, CRn, CRm, op2)` of the registers the emulation tests touch.
const OSLAR_EL1: (u8, u8, u8, u8, u8) = (2, 0, 1, 0, 4);
const OSLSR_EL1: (u8, u8, u8, u8, u8) = (2, 0, 1, 1, 4);
const OSDLR_EL1: (u8, u8, u8, u8, u8) = (2, 0, 1, 3, 4);
const MDCCSR_EL0: (u8, u8, u8, u8, u8) = (2, 3, 0, 1, 0);
const ID_AA64PFR2_EL1: (u8, u8, u8, u8, u8) = (3, 0, 0, 4, 2);
const PMCR_EL0: (u8, u8, u8, u8, u8) = (3, 3, 9, 12, 0);

fn access((op0, op1, crn, crm, op2): (u8, u8, u8, u8, u8), read: bool) -> SysRegAccess {
    SysRegAccess {
        op0,
        op1,
        crn,
        crm,
        op2,
        register: 1,
        read,
    }
}

#[test]
fn emulates_the_os_lock_and_reads_other_debug_and_id_registers_as_zero() {
    let mut os_lock = false;
    // OSLSR_EL1.OSLM = 0b10 (bit 3): the OS lock is implemented; OSLK is bit 1.
    assert_eq!(
        access(OSLSR_EL1, true).emulate(&mut os_lock, 0),
        Some(0b1000)
    );
    assert_eq!(access(OSLAR_EL1, false).emulate(&mut os_lock, 1), Some(0));
    assert_eq!(
        access(OSLSR_EL1, true).emulate(&mut os_lock, 0),
        Some(0b1010)
    );
    assert_eq!(access(OSLAR_EL1, false).emulate(&mut os_lock, 0), Some(0));
    assert_eq!(
        access(OSLSR_EL1, true).emulate(&mut os_lock, 0),
        Some(0b1000)
    );
    for register in [OSDLR_EL1, MDCCSR_EL0, ID_AA64PFR2_EL1] {
        assert_eq!(
            access(register, true).emulate(&mut os_lock, 0),
            Some(0),
            "{register:?}"
        );
    }
    assert_eq!(access(OSDLR_EL1, false).emulate(&mut os_lock, 1), Some(0));
    // ID registers are read-only, and nothing else traps on a Linux boot.
    assert_eq!(
        access(ID_AA64PFR2_EL1, false).emulate(&mut os_lock, 1),
        None
    );
    assert_eq!(access(PMCR_EL0, true).emulate(&mut os_lock, 0), None);
    assert!(!os_lock);
}

#[test]
fn decodes_the_psci_calls_linux_makes_on_a_0_2_firmware() {
    for (registers, call) in [
        ([0x8400_0000, 0, 0, 0], PsciCall::Version),
        ([0x8400_0006, 0, 0, 0], PsciCall::MigrateInfoType),
        ([0x8400_0008, 0, 0, 0], PsciCall::SystemOff),
        ([0x8400_0009, 0, 0, 0], PsciCall::SystemReset),
        (
            [0xc400_0003, 0x101, 0x8020_1000, 7],
            PsciCall::CpuOn {
                target: 0x101,
                entry: 0x8020_1000,
                context_id: 7,
            },
        ),
        // The upper half of X0 is not part of the function ID.
        ([0xffff_ffff_8400_0000, 0, 0, 0], PsciCall::Version),
        // PSCI_FEATURES is 1.0 and CPU_SUSPEND needs an idle driver.
        ([0x8400_000a, 0, 0, 0], PsciCall::NotSupported),
        ([0xc400_0001, 0, 0, 0], PsciCall::NotSupported),
    ] {
        assert_eq!(PsciCall::decode(registers), call, "{registers:x?}");
    }
}

#[test]
fn returns_the_psci_code_of_each_cpu_on_result() {
    for (result, code) in [
        (CpuOnResult::Success, 0),
        (CpuOnResult::InvalidParameters, -2),
        (CpuOnResult::AlreadyOn, -4),
        (CpuOnResult::InternalFailure, -6),
    ] {
        assert_eq!(psci::cpu_on_return(result), code as u64, "{result:?}");
    }
}

#[test]
fn maps_each_hvf_error_to_an_io_kind_and_keeps_its_code() {
    check(0).unwrap();
    for (code, kind) in [
        (0xfae9_4007_u32, io::ErrorKind::PermissionDenied),
        (0xfae9_400f, io::ErrorKind::Unsupported),
        (0xfae9_4006, io::ErrorKind::Unsupported),
        (0xfae9_4002, io::ErrorKind::ResourceBusy),
        (0xfae9_4005, io::ErrorKind::OutOfMemory),
        (0xfae9_4003, io::ErrorKind::InvalidInput),
        (0xfae9_4001, io::ErrorKind::Other),
        (0xfae9_4008, io::ErrorKind::Other),
    ] {
        let error = check(code as i32).unwrap_err();
        assert_eq!(error.kind(), kind, "{code:#x}");
        assert!(error.to_string().contains(&format!("{code:#x}")), "{error}");
    }
}

#[test]
fn the_backend_imports_no_call_that_needs_macos_15() {
    // A binary built for macOS 12 or later binds every import at launch, so
    // one GIC import would stop it from starting on macOS 12 to 14.
    let binary = std::env::current_exe().unwrap();
    let output = Command::new("nm")
        .arg("-u")
        .arg(&binary)
        .output()
        .expect("run nm");
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "nm failed: {stderr}");
    let imports = String::from_utf8_lossy(&output.stdout);
    let gic: Vec<_> = imports
        .lines()
        .filter(|symbol| symbol.contains("hv_gic_"))
        .collect();
    assert!(gic.is_empty(), "imports that need macOS 15: {gic:?}");
}

// Hardware tests: a real VM on Hypervisor.framework.

/// A process holds one HVF VM at a time.
static HVF: Mutex<()> = Mutex::new(());

const GICD: u64 = 0x3fff_0000;
const GICR: u64 = 0x3dff_0000;
const RAM: u64 = 0x8000_0000;
const RAM_SIZE: usize = 2 << 20;
/// An address no RAM backs, so every access to it is an MMIO exit.
const MMIO: u64 = 0x0900_0000;
/// EL1h with D, A, I and F masked, as Linux expects at entry.
const PSTATE_EL1H_DAIF: u64 = 0x3c5;
/// The SPI the interrupt test raises: the first one HVF offers.
const SPI: u32 = 32;

/// Encodes the few A64 instructions the test guests use.
mod a64 {
    pub const HVC: u32 = 0xd400_0002;
    pub const SMC: u32 = 0xd400_0003;
    pub const WFI: u32 = 0xd503_207f;
    /// `b .`: spin until kicked.
    pub const SPIN: u32 = 0x1400_0000;
    pub const XZR: u32 = 31;
    /// The register holding the MMIO base in every test guest.
    pub const BASE: u32 = 9;

    /// `xd = value`, as `movz` then three `movk`s.
    pub fn mov(xd: u32, value: u64) -> [u32; 4] {
        let half = |shift: u32| ((value >> shift) & 0xffff) as u32;
        [
            0xd280_0000 | half(0) << 5 | xd,
            0xf2a0_0000 | half(16) << 5 | xd,
            0xf2c0_0000 | half(32) << 5 | xd,
            0xf2e0_0000 | half(48) << 5 | xd,
        ]
    }

    /// `str xt, [x9, #offset]`, 8 bytes.
    pub fn store64(xt: u32, offset: u32) -> u32 {
        0xf900_0000 | (offset / 8) << 10 | BASE << 5 | xt
    }

    /// `str wt, [x9, #offset]`, 4 bytes.
    pub fn store32(wt: u32, offset: u32) -> u32 {
        0xb900_0000 | (offset / 4) << 10 | BASE << 5 | wt
    }

    /// `strb wt, [x9, #offset]`.
    pub fn store8(wt: u32, offset: u32) -> u32 {
        0x3900_0000 | offset << 10 | BASE << 5 | wt
    }

    /// `ldr xt, [x9, #offset]`.
    pub fn load64(xt: u32, offset: u32) -> u32 {
        0xf940_0000 | (offset / 8) << 10 | BASE << 5 | xt
    }

    /// `ldrsb xt, [x9, #offset]`.
    pub fn load_signed8_x(xt: u32, offset: u32) -> u32 {
        0x3980_0000 | offset << 10 | BASE << 5 | xt
    }

    /// `ldrsb wt, [x9, #offset]`.
    pub fn load_signed8_w(wt: u32, offset: u32) -> u32 {
        0x39c0_0000 | offset << 10 | BASE << 5 | wt
    }

    /// `ldrh wt, [x9, #offset]`.
    pub fn load16(wt: u32, offset: u32) -> u32 {
        0x7940_0000 | (offset / 2) << 10 | BASE << 5 | wt
    }

    /// `ldp x1, x2, [x9]`: a pair load, whose syndrome names no register.
    pub const LOAD_PAIR: u32 = 0xa940_0000 | 2 << 10 | BASE << 5 | 1;

    /// `dc civac, x9`: clean and invalidate the data cache line at x9.
    pub const DC_CIVAC: u32 = 0xd50b_7e20 | BASE;

    /// A system register as `(op0, op1, CRn, CRm, op2)`.
    pub type SysReg = (u32, u32, u32, u32, u32);
    pub const OSLAR_EL1: SysReg = (2, 0, 1, 0, 4);
    pub const OSLSR_EL1: SysReg = (2, 0, 1, 1, 4);
    pub const OSDLR_EL1: SysReg = (2, 0, 1, 3, 4);
    pub const MPIDR_EL1: SysReg = (3, 0, 0, 0, 5);

    fn system((op0, op1, crn, crm, op2): SysReg) -> u32 {
        (op0 - 2) << 19 | op1 << 16 | crn << 12 | crm << 8 | op2 << 5
    }

    /// `msr register, xt`.
    pub fn msr(register: SysReg, xt: u32) -> u32 {
        0xd510_0000 | system(register) | xt
    }

    /// `mrs xt, register`.
    pub fn mrs(xt: u32, register: SysReg) -> u32 {
        0xd530_0000 | system(register) | xt
    }

    /// A PSCI call: `x0 = function`, then `hvc #0`.
    pub fn psci(function: u64) -> Vec<u32> {
        let mut code = mov(0, function).to_vec();
        code.push(HVC);
        code
    }
}

/// PSCI function IDs (`include/uapi/linux/psci.h`).
const PSCI_VERSION: u64 = 0x8400_0000;
const PSCI_MIGRATE_INFO_TYPE: u64 = 0x8400_0006;
const PSCI_SYSTEM_OFF: u64 = 0x8400_0008;
const PSCI_SYSTEM_RESET: u64 = 0x8400_0009;
const PSCI_CPU_ON_64: u64 = 0xc400_0003;
const PSCI_CPU_SUSPEND_64: u64 = 0xc400_0001;

/// 2 MiB of zeroed guest RAM, page aligned for HVF and freed on drop.
struct Ram(NonNull<u8>);

impl Ram {
    const LAYOUT: Layout = match Layout::from_size_align(RAM_SIZE, 16 << 10) {
        Ok(layout) => layout,
        Err(_) => panic!("invalid RAM layout"),
    };

    fn new() -> Self {
        // SAFETY: the layout has a non-zero size.
        let ptr = unsafe { alloc::alloc_zeroed(Self::LAYOUT) };
        Self(NonNull::new(ptr).expect("allocate guest RAM"))
    }

    fn region(&self) -> MemoryRegion {
        MemoryRegion {
            guest_addr: RAM,
            host_addr: self.0,
            size: RAM_SIZE,
        }
    }

    /// Copies `code` to the start of RAM, where every test guest begins.
    fn load(&self, code: &[u32]) {
        assert!(code.len() * 4 <= RAM_SIZE);
        // SAFETY: the copy stays inside the allocation, and no vCPU runs yet.
        unsafe {
            std::ptr::copy_nonoverlapping(code.as_ptr().cast(), self.0.as_ptr(), code.len() * 4);
        }
    }
}

impl Drop for Ram {
    fn drop(&mut self) {
        // SAFETY: allocated in `new` with the same layout.
        unsafe { alloc::dealloc(self.0.as_ptr(), Self::LAYOUT) };
    }
}

/// One VM with RAM at `RAM`. Fields drop in order: the VM, which releases
/// the mapping, before the RAM behind it, then the process-wide lock.
struct Guest {
    vm: HvfVm,
    ram: Ram,
    _hvf: MutexGuard<'static, ()>,
}

impl Guest {
    fn new() -> Self {
        let hvf = HVF.lock().unwrap_or_else(PoisonError::into_inner);
        let vm = HvfVm::new(GICD, GICR).expect("create the HVF VM");
        let ram = Ram::new();
        // SAFETY: `Guest` drops the VM before the RAM, and nothing else
        // touches the RAM while a vCPU runs.
        unsafe { vm.map_memory(&ram.region()) }.expect("map guest RAM");
        Self { vm, ram, _hvf: hvf }
    }

    /// Loads `code` and creates vCPU 0, on this thread, ready to enter it
    /// with the MMIO base in x9.
    fn vcpu(&self, code: &[u32]) -> HvfVcpu {
        let mut program = a64::mov(a64::BASE, MMIO).to_vec();
        program.extend_from_slice(code);
        self.ram.load(&program);
        let mut vcpu = self.vm.create_vcpu(0).expect("create vCPU 0");
        vcpu.set_mpidr(0).unwrap();
        vcpu.set_boot_registers(&Arm64BootRegisters {
            pc: RAM,
            x0: 0,
            pstate: PSTATE_EL1H_DAIF,
        })
        .unwrap();
        vcpu
    }
}

/// Runs `vcpu` to its next exit, which must be an MMIO write, and returns its
/// offset from `MMIO` and its value.
fn next_write(vcpu: &mut HvfVcpu) -> (u64, u64) {
    match vcpu.run().expect("run") {
        VcpuExit::MmioWrite { guest_addr, bytes } => {
            let mut value = [0; 8];
            value[..bytes.len()].copy_from_slice(bytes);
            (guest_addr - MMIO, u64::from_le_bytes(value))
        }
        other => panic!("expected an MMIO write, got {other:?}"),
    }
}

/// Runs `vcpu` to its next exit, which must be an MMIO read of `len` bytes at
/// `MMIO + offset`, and answers it with `value`.
fn answer_read(vcpu: &mut HvfVcpu, offset: u64, len: usize, value: u64) {
    match vcpu.run().expect("run") {
        VcpuExit::MmioRead { guest_addr, bytes } => {
            assert_eq!((guest_addr - MMIO, bytes.len()), (offset, len));
            bytes.copy_from_slice(&value.to_le_bytes()[..len]);
        }
        other => panic!("expected an MMIO read, got {other:?}"),
    }
}

unsafe extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
}

/// `RTLD_DEFAULT` (`dlfcn.h`): search every image the process has loaded.
const RTLD_DEFAULT: *mut c_void = -2_isize as *mut c_void;

/// Looks Hypervisor.framework call `name` up at run time, as the backend
/// does its GIC calls, so this binary imports no call that needs macOS 15.
///
/// # Safety
///
/// `F` must be the function-pointer type of the call's C declaration.
unsafe fn hvf_call<F: Copy>(name: &CStr) -> F {
    const { assert!(mem::size_of::<F>() == mem::size_of::<*mut c_void>()) };
    // SAFETY: the lookup only reads the NUL-terminated name.
    let address = unsafe { dlsym(RTLD_DEFAULT, name.as_ptr()) };
    assert!(!address.is_null(), "Hypervisor.framework has no {name:?}");
    // SAFETY: the caller names the call's type, whose size matches.
    unsafe { mem::transmute_copy(&address) }
}

// The GIC registers the interrupt test programs (`hv_gic.h`); each register
// enum is its GICv3 offset.
const GICD_CTLR: u16 = 0x0000;
const GICD_IGROUPR: u16 = 0x0080;
const GICD_ISENABLER: u16 = 0x0100;
const GICD_IROUTER: u16 = 0x6000;
const ICC_PMR_EL1: u16 = 0xc230;
const ICC_IGRPEN1_EL1: u16 = 0xc667;

/// Programs the in-kernel GIC so `SPI` is a group 1 interrupt routed to
/// `vcpu`, affinity 0, and lets the vCPU take every priority.
fn route_spi_to(vcpu: &HvfVcpu) {
    let word = (SPI / 32) as u16;
    let bit = 1u64 << (SPI % 32);
    // SAFETY: each type is the call's declaration in `hv_gic.h`; register
    // accesses on a GIC and a vCPU that exist; the vCPU's own registers are
    // written from its owning thread.
    unsafe {
        let hv_gic_get_distributor_reg: unsafe extern "C" fn(u16, *mut u64) -> i32 =
            hvf_call(c"hv_gic_get_distributor_reg");
        let hv_gic_set_distributor_reg: unsafe extern "C" fn(u16, u64) -> i32 =
            hvf_call(c"hv_gic_set_distributor_reg");
        let hv_gic_set_icc_reg: unsafe extern "C" fn(u64, u16, u64) -> i32 =
            hvf_call(c"hv_gic_set_icc_reg");
        let mut ctlr = 0;
        check(hv_gic_get_distributor_reg(GICD_CTLR, &mut ctlr)).unwrap();
        // ARE and EnableGrp1, keeping what HVF set.
        check(hv_gic_set_distributor_reg(GICD_CTLR, ctlr | 0x12)).unwrap();
        check(hv_gic_set_distributor_reg(GICD_IGROUPR + 4 * word, bit)).unwrap();
        check(hv_gic_set_distributor_reg(GICD_ISENABLER + 4 * word, bit)).unwrap();
        check(hv_gic_set_distributor_reg(GICD_IROUTER + 8 * SPI as u16, 0)).unwrap();
        check(hv_gic_set_icc_reg(vcpu.vcpu, ICC_PMR_EL1, 0xff)).unwrap();
        check(hv_gic_set_icc_reg(vcpu.vcpu, ICC_IGRPEN1_EL1, 1)).unwrap();
    }
}

#[test]
#[ignore = "requires Hypervisor.framework; run make test:integration:vmm:hvf"]
fn a_process_holds_one_vm_and_creates_another_after_drop() {
    let _hvf = HVF.lock().unwrap_or_else(PoisonError::into_inner);
    let vm = HvfVm::new(GICD, GICR).unwrap();
    let Err(Error::CreateVm(source)) = HvfVm::new(GICD, GICR) else {
        panic!("a second VM in one process");
    };
    assert_eq!(source.kind(), io::ErrorKind::ResourceBusy, "{source}");
    drop(vm);
    HvfVm::new(GICD, GICR).expect("a VM after the first one dropped");
}

#[test]
#[ignore = "requires Hypervisor.framework; run make test:integration:vmm:hvf"]
fn rejects_gic_bases_hvf_cannot_use_and_releases_the_vm() {
    let _hvf = HVF.lock().unwrap_or_else(PoisonError::into_inner);
    for (distributor, redistributors) in [
        // Not aligned to the 64 KiB HVF requires.
        (GICD + 0x1000, GICR),
        // The redistributor region would cover the distributor.
        (GICD, GICD - 0x1_0000),
    ] {
        let Err(Error::CreateVm(source)) = HvfVm::new(distributor, redistributors) else {
            panic!("accepted {distributor:#x}, {redistributors:#x}");
        };
        assert_eq!(source.kind(), io::ErrorKind::InvalidInput, "{source}");
    }
    HvfVm::new(GICD, GICR).expect("each failed create destroyed its VM");
}

#[test]
#[ignore = "requires Hypervisor.framework; run make test:integration:vmm:hvf"]
fn unmapped_ram_becomes_a_hole_and_a_misaligned_unmap_fails() {
    let guest = Guest::new();
    let half = RAM_SIZE / 2;
    let upper = RAM + half as u64;
    guest
        .vm
        .unmap_memory(&MemoryRegion {
            guest_addr: upper,
            // SAFETY: the offset stays inside the allocation.
            host_addr: unsafe { guest.ram.0.add(half) },
            size: half,
        })
        .unwrap();
    // The guest code stays in the lower half; a load from the upper half now
    // reaches the VMM.
    let mut code = a64::mov(a64::BASE, upper).to_vec();
    code.push(a64::load64(1, 0));
    let mut vcpu = guest.vcpu(&code);
    match vcpu.run().unwrap() {
        VcpuExit::MmioRead { guest_addr, .. } => assert_eq!(guest_addr, upper),
        other => panic!("expected a read from the hole, got {other:?}"),
    }
    let Err(Error::UnmapMemory { guest_addr, .. }) = guest.vm.unmap_memory(&MemoryRegion {
        guest_addr: RAM + 1,
        host_addr: guest.ram.0,
        size: 0x4000,
    }) else {
        panic!("unmapped a range that is not page aligned");
    };
    assert_eq!(guest_addr, RAM + 1);
}

#[test]
#[ignore = "requires Hypervisor.framework; run make test:integration:vmm:hvf"]
fn mmio_writes_carry_the_address_width_and_data() {
    let guest = Guest::new();
    let mut code = a64::mov(1, 0x8877_6655_4433_2211).to_vec();
    code.extend([
        a64::store32(1, 0x10),
        a64::store8(1, 0x21),
        a64::store64(1, 0x28),
        a64::store64(a64::XZR, 0x30),
    ]);
    code.extend(a64::psci(PSCI_SYSTEM_OFF));
    let mut vcpu = guest.vcpu(&code);
    for expected in [
        (0x10, 0x4433_2211),
        (0x21, 0x11),
        (0x28, 0x8877_6655_4433_2211),
        // XZR stores zero, not whatever register 31 holds in HVF (PC).
        (0x30, 0),
    ] {
        assert_eq!(next_write(&mut vcpu), expected);
    }
    assert!(matches!(vcpu.run().unwrap(), VcpuExit::Shutdown));
}

#[test]
#[ignore = "requires Hypervisor.framework; run make test:integration:vmm:hvf"]
fn mmio_reads_land_in_the_target_register_extended() {
    let guest = Guest::new();
    let mut code = vec![
        a64::load_signed8_x(5, 0),
        a64::load_signed8_w(6, 1),
        a64::load16(7, 2),
        a64::load64(8, 8),
        // A load into XZR discards the value and must leave PC alone.
        a64::load64(a64::XZR, 16),
    ];
    for (register, offset) in [(5, 0x20), (6, 0x28), (7, 0x30), (8, 0x38)] {
        code.push(a64::store64(register, offset));
    }
    code.extend(a64::psci(PSCI_SYSTEM_OFF));
    let mut vcpu = guest.vcpu(&code);
    answer_read(&mut vcpu, 0, 1, 0x80);
    answer_read(&mut vcpu, 1, 1, 0x80);
    answer_read(&mut vcpu, 2, 2, 0x8001);
    answer_read(&mut vcpu, 8, 8, 0x1122_3344_5566_7788);
    answer_read(&mut vcpu, 16, 8, u64::MAX);
    for expected in [
        (0x20, 0xffff_ffff_ffff_ff80),
        (0x28, 0x0000_0000_ffff_ff80),
        (0x30, 0x8001),
        (0x38, 0x1122_3344_5566_7788),
    ] {
        assert_eq!(next_write(&mut vcpu), expected);
    }
    assert!(matches!(vcpu.run().unwrap(), VcpuExit::Shutdown));
}

#[test]
#[ignore = "requires Hypervisor.framework; run make test:integration:vmm:hvf"]
fn completing_a_read_without_entry_writes_it_once_and_moves_past_it() {
    let guest = Guest::new();
    let mut code = vec![a64::load64(5, 0), a64::store64(5, 8)];
    code.extend(a64::psci(PSCI_SYSTEM_OFF));
    let mut vcpu = guest.vcpu(&code);
    answer_read(&mut vcpu, 0, 8, 0x55);
    vcpu.complete_pending_io().unwrap();
    // A second completion has nothing left to do.
    vcpu.complete_pending_io().unwrap();
    assert_eq!(next_write(&mut vcpu), (8, 0x55));
}

#[test]
#[ignore = "requires Hypervisor.framework; run make test:integration:vmm:hvf"]
fn completing_mmio_at_the_last_virtual_instruction_wraps_pc() {
    use super::ffi;

    let guest = Guest::new();
    let write_entry = |offset: usize, value: u64| {
        // SAFETY: these aligned table entries are inside RAM before guest entry.
        unsafe { guest.ram.0.as_ptr().add(offset).cast::<u64>().write(value) };
    };
    // TTBR0 uses 39-bit virtual addresses and 1 GiB identity-mapped blocks.
    // MAIR index 0 is device memory; index 1 is normal, inner-shareable memory.
    let normal = (1 << 10) | (3 << 8) | (1 << 2); // AF, SH, AttrIndx
    write_entry(0x1000, (1 << 10) | 1);
    write_entry(0x1010, RAM | normal | 1);
    // TTBR1 walks three 4 KiB tables to map the final virtual page to RAM.
    write_entry(0x2000 + 511 * 8, (RAM + 0x3000) | 3);
    write_entry(0x3000 + 511 * 8, (RAM + 0x4000) | 3);
    write_entry(0x4000 + 511 * 8, (RAM + 0xf000) | normal | 3);
    // SAFETY: this aligned word is inside RAM, and no vCPU runs yet.
    unsafe {
        guest
            .ram
            .0
            .as_ptr()
            .add(0xfffc)
            .cast::<u32>()
            .write(a64::store64(a64::XZR, 0));
    }
    // 40-bit physical addresses, 4 KiB granules, and 39-bit virtual addresses;
    // both table walks use inner-shareable, write-back cacheable memory.
    let tcr = (2u64 << 32)
        | (2 << 30)
        | (3 << 28)
        | (1 << 26)
        | (1 << 24)
        | (25 << 16)
        | (3 << 12)
        | (1 << 10)
        | (1 << 8)
        | 25;
    let mut code = Vec::new();
    for (register, value) in [
        ((3, 0, 2, 0, 0), RAM + 0x1000), // TTBR0_EL1
        ((3, 0, 2, 0, 1), RAM + 0x2000), // TTBR1_EL1
        ((3, 0, 2, 0, 2), tcr),          // TCR_EL1
        ((3, 0, 10, 2, 0), 0xff00),      // MAIR_EL1
    ] {
        code.extend(a64::mov(0, value));
        code.push(a64::msr(register, 0));
    }
    code.extend(a64::mov(10, u64::MAX - 3));
    code.extend([
        0xd503_3f9f,                  // dsb sy
        0xd503_3fdf,                  // isb
        a64::mrs(0, (3, 0, 1, 0, 0)), // mrs x0, sctlr_el1
        0xb240_0000,                  // orr x0, x0, #1: enable the MMU
        a64::msr((3, 0, 1, 0, 0), 0), // msr sctlr_el1, x0
        0xd503_3fdf,                  // isb
        0xd61f_0140,                  // br x10
    ]);
    let mut vcpu = guest.vcpu(&code);
    assert_eq!(next_write(&mut vcpu), (0, 0));

    let mut pc = 0;
    // SAFETY: this live vCPU belongs to the calling thread.
    check(unsafe { ffi::hv_vcpu_get_reg(vcpu.vcpu, ffi::HV_REG_PC, &mut pc) }).unwrap();
    assert_eq!(pc, u64::MAX - 3, "the guest reached the boundary itself");
    eprintln!("MMIO exit at PC {pc:#018x}");
    vcpu.complete_pending_io().unwrap();
    // SAFETY: completion keeps the vCPU alive on this thread without guest entry.
    check(unsafe { ffi::hv_vcpu_get_reg(vcpu.vcpu, ffi::HV_REG_PC, &mut pc) }).unwrap();
    assert_eq!(pc, 0, "completion wraps the 64-bit PC");
}

#[test]
#[ignore = "requires Hypervisor.framework; run make test:integration:vmm:hvf"]
fn cache_maintenance_on_mmio_is_skipped_without_an_exit() {
    let guest = Guest::new();
    let mut vcpu = guest.vcpu(&[a64::DC_CIVAC, a64::store64(a64::XZR, 8)]);
    // The data abort the cache maintenance raises never reaches the VMM.
    assert_eq!(next_write(&mut vcpu), (8, 0));
}

#[test]
#[ignore = "requires Hypervisor.framework; run make test:integration:vmm:hvf"]
fn answers_psci_queries_without_an_exit_and_ends_on_system_off() {
    let guest = Guest::new();
    let mut code = Vec::new();
    for (function, offset) in [
        (PSCI_VERSION, 0),
        (PSCI_MIGRATE_INFO_TYPE, 8),
        (PSCI_CPU_SUSPEND_64, 16),
    ] {
        code.extend(a64::psci(function));
        code.push(a64::store64(0, offset));
    }
    code.extend(a64::psci(PSCI_SYSTEM_OFF));
    let mut vcpu = guest.vcpu(&code);
    // PSCI 0.2; no Trusted OS to migrate; NOT_SUPPORTED.
    for expected in [(0, 2), (8, 2), (16, u64::MAX)] {
        assert_eq!(next_write(&mut vcpu), expected);
    }
    assert!(matches!(vcpu.run().unwrap(), VcpuExit::Shutdown));
}

#[test]
#[ignore = "requires Hypervisor.framework; run make test:integration:vmm:hvf"]
fn system_reset_ends_with_a_reset() {
    let guest = Guest::new();
    let mut vcpu = guest.vcpu(&a64::psci(PSCI_SYSTEM_RESET));
    assert!(matches!(vcpu.run().unwrap(), VcpuExit::Reset));
}

#[test]
#[ignore = "requires Hypervisor.framework; run make test:integration:vmm:hvf"]
fn cpu_on_hands_the_vmm_its_arguments_and_returns_its_answer() {
    let guest = Guest::new();
    let mut code = Vec::new();
    for offset in [0, 8] {
        code.extend(a64::mov(1, 0x101));
        code.extend(a64::mov(2, RAM + 0x1000));
        code.extend(a64::mov(3, 7));
        code.extend(a64::psci(PSCI_CPU_ON_64));
        code.push(a64::store64(0, offset));
    }
    code.extend(a64::psci(PSCI_SYSTEM_OFF));
    let mut vcpu = guest.vcpu(&code);
    for (answer, expected) in [
        (CpuOnResult::Success, (0, 0)),
        (CpuOnResult::AlreadyOn, (8, (-4_i64) as u64)),
    ] {
        match vcpu.run().unwrap() {
            VcpuExit::CpuOn {
                target,
                entry,
                context_id,
                result,
            } => {
                assert_eq!((target, entry, context_id), (0x101, RAM + 0x1000, 7));
                *result = answer;
            }
            other => panic!("expected CPU_ON, got {other:?}"),
        }
        assert_eq!(next_write(&mut vcpu), expected);
    }
}

#[test]
#[ignore = "requires Hypervisor.framework; run make test:integration:vmm:hvf"]
fn smc_and_a_pair_load_from_mmio_are_unhandled() {
    for instruction in [a64::SMC, a64::LOAD_PAIR] {
        let guest = Guest::new();
        let mut vcpu = guest.vcpu(&[instruction]);
        let Err(Error::UnhandledExit { id, reason }) = vcpu.run() else {
            panic!("handled {instruction:#x}");
        };
        assert_eq!(id, 0, "{reason}");
    }
}

#[test]
#[ignore = "requires Hypervisor.framework; run make test:integration:vmm:hvf"]
fn emulates_the_os_lock_linux_clears_at_boot() {
    let guest = Guest::new();
    let mut code = a64::mov(1, 1).to_vec();
    code.extend([
        a64::msr(a64::OSLAR_EL1, 1),
        a64::mrs(2, a64::OSLSR_EL1),
        a64::store64(2, 0),
        a64::msr(a64::OSLAR_EL1, a64::XZR),
        a64::mrs(2, a64::OSLSR_EL1),
        a64::store64(2, 8),
        a64::mrs(3, a64::OSDLR_EL1),
        a64::store64(3, 16),
    ]);
    code.extend(a64::psci(PSCI_SYSTEM_OFF));
    let mut vcpu = guest.vcpu(&code);
    for expected in [(0, 0b1010), (8, 0b1000), (16, 0)] {
        assert_eq!(next_write(&mut vcpu), expected);
    }
}

#[test]
#[ignore = "requires Hypervisor.framework; run make test:integration:vmm:hvf"]
fn the_guest_reads_the_mpidr_the_vmm_set() {
    let guest = Guest::new();
    let mut code = vec![a64::mrs(1, a64::MPIDR_EL1), a64::store64(1, 0)];
    code.extend(a64::psci(PSCI_SYSTEM_OFF));
    let mut vcpu = guest.vcpu(&code);
    vcpu.set_mpidr(0x101).unwrap();
    let (_, mpidr) = next_write(&mut vcpu);
    assert_eq!(mpidr & 0xff_ffff, 0x101);
}

#[test]
#[ignore = "requires Hypervisor.framework; run make test:integration:vmm:hvf"]
fn wfi_waits_inside_hvf_until_another_thread_raises_an_spi() {
    let guest = Guest::new();
    let mut code = vec![a64::WFI, a64::store64(a64::XZR, 0)];
    code.extend(a64::psci(PSCI_SYSTEM_OFF));
    let mut vcpu = guest.vcpu(&code);
    route_spi_to(&vcpu);
    let delay = Duration::from_millis(100);
    let started = Instant::now();
    thread::scope(|scope| {
        scope.spawn(|| {
            thread::sleep(delay);
            guest.vm.set_irq_line(SPI, true).unwrap();
        });
        assert_eq!(next_write(&mut vcpu), (0, 0));
    });
    assert!(
        started.elapsed() >= delay,
        "WFI ended after {:?}",
        started.elapsed()
    );
    guest.vm.set_irq_line(SPI, false).unwrap();
}

#[test]
#[ignore = "requires Hypervisor.framework; run make test:integration:vmm:hvf"]
fn a_kick_before_entry_returns_without_running_the_guest() {
    let guest = Guest::new();
    let mut vcpu = guest.vcpu(&[a64::store64(a64::XZR, 0), a64::SPIN]);
    vcpu.handle().kick().unwrap();
    assert!(matches!(vcpu.run().unwrap(), VcpuExit::Interrupted));
    // The first store comes only now: the kicked entry ran nothing.
    assert_eq!(next_write(&mut vcpu), (0, 0));
}

#[test]
#[ignore = "requires Hypervisor.framework; run make test:integration:vmm:hvf"]
fn a_kick_from_another_thread_ends_a_wfi_wait_and_a_spin() {
    for instruction in [a64::WFI, a64::SPIN] {
        let guest = Guest::new();
        let mut code = vec![instruction];
        code.extend(a64::psci(PSCI_SYSTEM_OFF));
        let mut vcpu = guest.vcpu(&code);
        let handle = vcpu.handle();
        let delay = Duration::from_millis(100);
        let started = Instant::now();
        thread::scope(|scope| {
            scope.spawn(|| {
                thread::sleep(delay);
                handle.kick().unwrap();
            });
            assert!(matches!(vcpu.run().unwrap(), VcpuExit::Interrupted));
        });
        assert!(started.elapsed() >= delay, "{instruction:#x}");
    }
}

#[test]
#[ignore = "requires Hypervisor.framework; run make test:integration:vmm:hvf"]
fn kicking_a_dropped_vcpu_reaches_no_other_vcpu() {
    let guest = Guest::new();
    let first = guest.vcpu(&[a64::store64(a64::XZR, 0)]);
    let (stale, first_id) = (first.handle(), first.vcpu);
    drop(first);
    let mut second = guest.vcpu(&[a64::store64(a64::XZR, 0)]);
    assert_eq!(second.vcpu, first_id, "HVF reuses a freed vCPU ID");
    stale.kick().unwrap();
    // A kick through the old ID would hold here and return `Interrupted`.
    assert_eq!(next_write(&mut second), (0, 0));
}
