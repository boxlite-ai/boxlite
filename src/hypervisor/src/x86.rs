// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Architectural values supplied by the machine's boot loader, and the x86
//! backend operations that install them.

use crate::{Result, Vcpu, Vm};

/// One CPUID response; the VMM selects guest features and topology.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct X86CpuidEntry {
    pub leaf: u32,
    pub subleaf: u32,
    pub subleaf_required: bool,
    pub eax: u32,
    pub ebx: u32,
    pub ecx: u32,
    pub edx: u32,
}

/// One model-specific register write selected by the VMM.
#[derive(Clone, Copy, Debug)]
pub struct X86Msr {
    pub index: u32,
    pub value: u64,
}

/// A decoded x86 segment descriptor, independent of the host API.
#[derive(Clone, Copy, Debug, Default)]
pub struct X86Segment {
    pub base: u64,
    pub limit: u32,
    pub selector: u16,
    /// Access byte followed by the flags nibble in bits 12..15, as in a GDT.
    pub attributes: u16,
}

/// The registers needed to enter an x86 kernel directly.
///
/// The machine owns these values, including mode bits and all guest addresses.
/// Other general-purpose registers start at zero; x87/SSE start in reset state.
/// Secondary CPUs should retain their architectural reset state until INIT/SIPI.
#[derive(Clone, Copy, Debug, Default)]
pub struct X86BootRegisters {
    pub rip: u64,
    pub rsp: u64,
    pub rsi: u64,
    pub rflags: u64,
    pub cr0: u64,
    pub cr3: u64,
    pub cr4: u64,
    pub efer: u64,
    pub code: X86Segment,
    pub data: X86Segment,
    pub gdt_base: u64,
    pub gdt_limit: u16,
    pub idt_base: u64,
    pub idt_limit: u16,
}

/// Boot configuration and paused platform-state transfer for an x86 VM.
pub trait X86Vm: Vm<Vcpu: X86Vcpu> {
    /// Captures VM-global state with all vCPUs and IRQ producers stopped.
    /// Complete pending userspace I/O first. Non-snapshot backends report Unsupported.
    #[cfg(target_os = "linux")]
    fn save_state(&self) -> Result<X86VmState> {
        Err(crate::Error::CreateVm(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "save VM state (unsupported backend)",
        )))
    }

    /// Overwrites platform state on an identically configured, stopped VM.
    /// Discard the destination after any ioctl error: writes are not transactional.
    #[cfg(target_os = "linux")]
    fn restore_state(&self, _state: &X86VmState) -> Result<()> {
        Err(crate::Error::CreateVm(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "restore VM state (unsupported backend)",
        )))
    }

    /// Host-supported CPUID values, before the VMM applies guest topology and
    /// policy. They are a ceiling: a guest must not see features beyond them.
    fn supported_cpuid(&self) -> &[X86CpuidEntry];
}

/// Boot configuration and paused-state transfer for an x86 vCPU.
///
/// Writes are not transactional: discard the vCPU after any error.
pub trait X86Vcpu: Vcpu {
    /// Captures a stopped CPU without entering the guest. Complete I/O first.
    /// The image is architecture- and host-version-specific. The default reports
    /// Unsupported (with placeholder CPU id 0) for non-snapshot backends/mocks.
    #[cfg(target_os = "linux")]
    fn save_state(&mut self) -> Result<X86VcpuState> {
        Err(crate::Error::ConfigureVcpu {
            id: 0,
            operation: "save CPU state (unsupported backend)",
            source: std::io::Error::from(std::io::ErrorKind::Unsupported),
        })
    }

    /// Overwrites a fresh CPU without entering the guest. On any error, discard
    /// it: KVM has no transactional validation/rollback API. The default reports
    /// Unsupported (with placeholder CPU id 0) for non-snapshot backends/mocks.
    #[cfg(target_os = "linux")]
    fn restore_state(&mut self, _state: &X86VcpuState) -> Result<()> {
        Err(crate::Error::ConfigureVcpu {
            id: 0,
            operation: "restore CPU state (unsupported backend)",
            source: std::io::Error::from(std::io::ErrorKind::Unsupported),
        })
    }

    /// Installs the machine's CPUID and MSR policy. Call it before
    /// [`set_boot_registers`](Self::set_boot_registers).
    fn set_cpu_features(&mut self, cpuid: &[X86CpuidEntry], msrs: &[X86Msr]) -> Result<()>;

    /// Installs the entry registers. Only the boot vCPU needs them; the others
    /// keep their reset state until INIT/SIPI.
    fn set_boot_registers(&mut self, state: &X86BootRegisters) -> Result<()>;
}

/// VM-global KVM x86 platform state; not a portable or stable wire format.
///
/// Only supported on the same host and KVM environment, with the same enabled
/// VM capabilities (including in-kernel IRQ chips and PIT creation flags). All vCPUs,
/// userspace I/O and external IRQ producers must be quiescent during transfer.
/// RAM, per-vCPU state, IRQ routing and device/irqfd configuration are separate.
/// KVM's running timers make capture non-atomic even with stopped vCPUs.
/// SET_PIT2 reloads counters: channels 1/2's host `count_load_time` is rebased
/// by KVM, so exact sub-tick timer phase is not preserved by this ioctl.
///
/// A created PIT is captured even if the guest never programmed it: its reset
/// channels/flags must overwrite the destination, not be confused with no PIT.
#[cfg(target_os = "linux")]
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct X86VmState {
    /// PIC master (0), PIC slave (1), IOAPIC (2), in that order.
    pub irqchips: [X86IrqchipState; 3],
    /// None only when the source never created an in-kernel PIT.
    pub pit: Option<kvm_bindings::kvm_pit_state2>,
    /// Full GET_CLOCK image: guest nanoseconds (from which SET_CLOCK rebuilds
    /// the offset), flags, realtime and host TSC correlation. Restore excludes
    /// snapshot downtime by clearing KVM_CLOCK_REALTIME; other flags are metadata.
    pub clock: kvm_bindings::kvm_clock_data,
}

/// An owned IRQ-chip image with fully initialized backing storage.
///
/// Unlike a public raw union, the private image cannot be replaced with a
/// partially initialized member. Constructors zero it before writing a payload;
/// deserialization zero-fills the backing buffer. Exposes only shared access.
#[cfg(target_os = "linux")]
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct X86IrqchipState(kvm_bindings::kvm_irqchip);

#[cfg(target_os = "linux")]
impl X86IrqchipState {
    /// Builds a PIC image (chip ID 0 or 1).
    pub fn pic(chip_id: u32, pic: kvm_bindings::kvm_pic_state) -> Self {
        let mut image = kvm_bindings::kvm_irqchip {
            chip_id,
            ..Default::default()
        };
        image.chip.pic = pic;
        Self(image)
    }

    /// Builds the IOAPIC image (chip ID 2).
    pub fn ioapic(ioapic: kvm_bindings::kvm_ioapic_state) -> Self {
        let mut image = kvm_bindings::kvm_irqchip {
            chip_id: 2,
            ..Default::default()
        };
        image.chip.ioapic = ioapic;
        Self(image)
    }

    /// Immutable ioctl image; mutable access would break initialization guarantees.
    pub fn as_kvm(&self) -> &kvm_bindings::kvm_irqchip {
        &self.0
    }
}

#[cfg(target_os = "linux")]
impl PartialEq for X86IrqchipState {
    fn eq(&self, other: &Self) -> bool {
        let (a, b) = (&self.0, &other.0);
        if a.chip_id != b.chip_id || a.pad != b.pad {
            return false;
        }
        // Compare the active payload, not the inactive union tail. The private
        // image's constructors/decoder initialize every backing byte,
        // even if a caller supplies a mismatched tag via pic() or decoding.
        // SAFETY: that enforced invariant makes every union view initialized.
        unsafe {
            match a.chip_id {
                0 | 1 => a.chip.pic == b.chip.pic,
                2 => {
                    let (a, b) = (&a.chip.ioapic, &b.chip.ioapic);
                    a.base_address == b.base_address
                        && a.ioregsel == b.ioregsel
                        && a.id == b.id
                        && a.irr == b.irr
                        && a.pad == b.pad
                        && a.redirtbl
                            .iter()
                            .zip(&b.redirtbl)
                            .all(|(a, b)| a.bits == b.bits)
                }
                // Unknown IDs remain comparable; KVM handles ioctl validation.
                _ => a.chip.dummy == b.chip.dummy,
            }
        }
    }
}

/// A paused KVM x86 CPU image, specific to this architecture, host CPU and
/// KVM/kernel version; not a portable or stable wire format.
///
/// Includes the entire XSAVE area (including AVX and newer enabled components)
/// in addition to the dedicated FPU image. CPUID/MSR flexible arrays are owned.
/// MSRs are discovered with KVM_GET_MSR_INDEX_LIST and individually probed:
/// indices unavailable under this vCPU's CPUID/MCE configuration are omitted.
/// The x2APIC register range is represented by `lapic`, not by MSR accesses.
/// `tsc_khz` is KVM_GET_TSC_KHZ's scale input, not a VM-wide clock snapshot.
///
/// Requires completed userspace I/O and a stopped vCPU. Nested virtualization,
/// Hyper-V SynIC, guest-debug configuration, VM clock/irqchip/PIT state and RAM
/// are intentionally outside this image; restore those separately if used.
/// Restore requires a fresh, never-entered vCPU so omitted optional facilities
/// retain reset state, never arbitrary destination state. Do not enable dynamic
/// host XSTATE permissions after creating either the source or destination vCPU.
/// The caller must exclude paged 32-bit PAE guests: SREGS omits cached PDPTRs.
#[cfg(target_os = "linux")]
#[derive(Clone, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct X86VcpuState {
    pub regs: kvm_bindings::kvm_regs,
    pub sregs: kvm_bindings::kvm_sregs,
    #[serde(with = "fpu_serde")]
    pub fpu: kvm_bindings::kvm_fpu,
    /// Complete XSAVE buffer, including the kernel-sized flexible tail.
    /// Decoding permits at most 65536 u32 words (256 KiB), a policy ceiling
    /// with room for host XSTATE components beyond the fixed KVM region.
    #[serde(deserialize_with = "vcpu_state_serde::words::<_, _, 65536>")]
    pub xsave: Vec<u32>,
    /// Captured CPUID leaves; decoding uses KVM's maximum entry count,
    /// matching the buffer accepted by the restore path.
    #[serde(
        deserialize_with = "vcpu_state_serde::entries::<_, _, { kvm_bindings::KVM_MAX_CPUID_ENTRIES }>"
    )]
    pub cpuid: Vec<kvm_bindings::kvm_cpuid_entry2>,
    /// Readable KVM-advertised MSRs; decoding permits at most 4096 entries.
    /// This is a decoding policy, not KVM's per-ioctl MSR batch limit.
    #[serde(deserialize_with = "vcpu_state_serde::entries::<_, _, 4096>")]
    pub msrs: Vec<kvm_bindings::kvm_msr_entry>,
    pub xcrs: kvm_bindings::kvm_xcrs,
    pub debug_regs: kvm_bindings::kvm_debugregs,
    pub events: kvm_bindings::kvm_vcpu_events,
    pub mp_state: kvm_bindings::kvm_mp_state,
    pub lapic: kvm_bindings::kvm_lapic_state,
    pub tsc_khz: u32,
}

// Bounds are checked before reading elements; never reserve from an untrusted
// length. These guards also protect callers that decode X86VcpuState directly.
#[cfg(target_os = "linux")]
mod vcpu_state_serde {
    use serde::{
        Deserialize, Deserializer,
        de::{self, SeqAccess, Visitor},
    };
    use std::{fmt, marker::PhantomData};

    fn bounded<'de, D, T, const N: usize>(d: D) -> Result<Vec<T>, D::Error>
    where
        D: Deserializer<'de>,
        T: Deserialize<'de>,
    {
        struct Bounded<T, const N: usize>(PhantomData<T>);
        impl<'de, T: Deserialize<'de>, const N: usize> Visitor<'de> for Bounded<T, N> {
            type Value = Vec<T>;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "at most {N} CPU entries with an exact declared length")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let len = seq
                    .size_hint()
                    .filter(|&len| len <= N)
                    .ok_or_else(|| de::Error::custom("CPU sequence too long"))?;
                let mut values = Vec::new();
                for i in 0..len {
                    values.push(
                        seq.next_element()?
                            .ok_or_else(|| de::Error::invalid_length(i, &self))?,
                    );
                }
                if seq.next_element::<de::IgnoredAny>()?.is_some() {
                    return Err(de::Error::invalid_length(len + 1, &self));
                }
                Ok(values)
            }
        }
        d.deserialize_seq(Bounded::<T, N>(PhantomData))
    }

    pub(super) fn words<'de, D, T, const N: usize>(d: D) -> Result<Vec<T>, D::Error>
    where
        D: Deserializer<'de>,
        T: Deserialize<'de>,
    {
        bounded::<D, T, N>(d)
    }

    pub(super) fn entries<'de, D, T, const N: usize>(d: D) -> Result<Vec<T>, D::Error>
    where
        D: Deserializer<'de>,
        T: Deserialize<'de>,
    {
        bounded::<D, T, N>(d)
    }
}

// kvm-bindings omits kvm_fpu serde. Encode explicit fields into an exact ABI-
// sized byte buffer rather than reading C padding or using variable-width ints.
#[cfg(target_os = "linux")]
mod fpu_serde {
    use kvm_bindings::kvm_fpu;
    use serde::{Deserialize, Deserializer, Serializer, de};

    pub(super) fn serialize<S: Serializer>(f: &kvm_fpu, s: S) -> Result<S::Ok, S::Error> {
        let mut bytes = [0u8; size_of::<kvm_fpu>()];
        let mut offset = 0;
        macro_rules! put {
            ($value:expr) => {{
                let value = $value;
                bytes[offset..offset + value.len()].copy_from_slice(&value);
                offset += value.len();
            }};
        }
        for v in f.fpr {
            put!(v);
        }
        put!(f.fcw.to_le_bytes());
        put!(f.fsw.to_le_bytes());
        put!([f.ftwx, f.pad1]);
        put!(f.last_opcode.to_le_bytes());
        put!(f.last_ip.to_le_bytes());
        put!(f.last_dp.to_le_bytes());
        for v in f.xmm {
            put!(v);
        }
        put!(f.mxcsr.to_le_bytes());
        put!(f.pad2.to_le_bytes());
        debug_assert_eq!(offset, bytes.len());
        s.serialize_bytes(&bytes)
    }

    pub(super) fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<kvm_fpu, D::Error> {
        // Borrow first: no declared length causes allocation, even usize::MAX.
        let bytes = <&[u8]>::deserialize(d)?;
        if bytes.len() != size_of::<kvm_fpu>() {
            return Err(de::Error::custom("incorrect FPU ABI size"));
        }
        let mut offset = 0;
        macro_rules! get {
            ($n:expr) => {{
                let mut value = [0u8; $n];
                value.copy_from_slice(&bytes[offset..offset + $n]);
                offset += $n;
                value
            }};
        }
        let mut f = kvm_fpu::default();
        for v in &mut f.fpr {
            *v = get!(16);
        }
        f.fcw = u16::from_le_bytes(get!(2));
        f.fsw = u16::from_le_bytes(get!(2));
        f.ftwx = get!(1)[0];
        f.pad1 = get!(1)[0];
        f.last_opcode = u16::from_le_bytes(get!(2));
        f.last_ip = u64::from_le_bytes(get!(8));
        f.last_dp = u64::from_le_bytes(get!(8));
        for v in &mut f.xmm {
            *v = get!(16);
        }
        f.mxcsr = u32::from_le_bytes(get!(4));
        f.pad2 = u32::from_le_bytes(get!(4));
        debug_assert_eq!(offset, bytes.len());
        Ok(f)
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    #[test]
    fn cpu_sequences_enforce_declared_count_and_bound_before_elements() {
        use serde::{
            Deserializer,
            de::{
                DeserializeSeed, SeqAccess, Visitor,
                value::{Error, U8Deserializer},
            },
        };
        struct Sequence {
            declared: usize,
            actual: usize,
            reads: usize,
        }
        impl<'de> SeqAccess<'de> for &mut Sequence {
            type Error = Error;
            fn size_hint(&self) -> Option<usize> {
                Some(self.declared)
            }
            fn next_element_seed<T: DeserializeSeed<'de>>(
                &mut self,
                seed: T,
            ) -> Result<Option<T::Value>, Error> {
                self.reads += 1;
                if self.actual == 0 {
                    return Ok(None);
                }
                self.actual -= 1;
                seed.deserialize(U8Deserializer::new(42)).map(Some)
            }
        }
        impl<'de> Deserializer<'de> for &mut Sequence {
            type Error = Error;
            fn deserialize_any<V: Visitor<'de>>(self, v: V) -> Result<V::Value, Error> {
                v.visit_seq(self)
            }
            serde::forward_to_deserialize_any! {
                bool i8 i16 i32 i64 u8 u16 u32 u64 f32 f64 char str string
                bytes byte_buf option unit unit_struct newtype_struct seq tuple
                tuple_struct map struct enum identifier ignored_any
            }
        }
        for bound in [65536, 256, 4096] {
            // No element can be read, hence no element storage can be allocated.
            let mut seq = Sequence {
                declared: bound + 1,
                actual: 1,
                reads: 0,
            };
            let error = match bound {
                65536 => super::vcpu_state_serde::words::<_, u32, 65536>(&mut seq).unwrap_err(),
                256 => super::vcpu_state_serde::entries::<_, kvm_bindings::kvm_cpuid_entry2, 256>(
                    &mut seq,
                )
                .unwrap_err(),
                _ => super::vcpu_state_serde::entries::<_, kvm_bindings::kvm_msr_entry, 4096>(
                    &mut seq,
                )
                .unwrap_err(),
            };
            assert!(error.to_string().contains("too long"));
            assert_eq!(seq.reads, 0);
        }
        for (declared, actual) in [(0, 1), (1, 0), (1, 2), (1, 1)] {
            let mut seq = Sequence {
                declared,
                actual,
                reads: 0,
            };
            let result = super::vcpu_state_serde::words::<_, u8, 2>(&mut seq);
            assert_eq!(result.is_ok(), declared == actual);
        }
    }

    #[test]
    fn snapshot_state_supports_serde_and_equality() {
        fn assert_traits<T: serde::Serialize + for<'de> serde::Deserialize<'de> + PartialEq>() {}
        assert_traits::<super::X86VcpuState>();
    }
    #[test]
    fn vm_snapshot_state_supports_serde_and_equality() {
        fn assert_traits<T: serde::Serialize + for<'de> serde::Deserialize<'de> + PartialEq>() {}
        assert_traits::<super::X86VmState>();
    }

    #[test]
    fn vm_snapshot_pic_only_input_compares_active_payload() {
        use super::{X86IrqchipState, X86VmState};
        use kvm_bindings::{kvm_ioapic_state, kvm_pic_state};
        let mut state = X86VmState {
            // Only PIC payloads are supplied, never a full raw union image.
            irqchips: [
                X86IrqchipState::pic(
                    0,
                    kvm_pic_state {
                        imr: 0xa5,
                        ..Default::default()
                    },
                ),
                X86IrqchipState::pic(1, kvm_pic_state::default()),
                X86IrqchipState::ioapic(kvm_ioapic_state::default()),
            ],
            pit: None,
            clock: Default::default(),
        };
        let same = state.clone();
        assert_eq!(state, same);
        state.irqchips[0] = X86IrqchipState::pic(
            0,
            kvm_pic_state {
                imr: 0x5a,
                ..Default::default()
            },
        );
        assert_ne!(state, same);
        // A mismatched constructor tag is also initialized: equality must not
        // read uninitialized bytes even when the tag selects another payload.
        state.irqchips[0] = X86IrqchipState::pic(2, kvm_pic_state::default());
        assert_eq!(state, state.clone());
        // Inactive PIC-tail bytes do not affect equality after decoding.
        use serde::{
            Deserialize,
            de::value::{BorrowedBytesDeserializer, Error},
        };
        let mut bytes = vec![0u8; size_of::<kvm_bindings::kvm_irqchip>()];
        let zero =
            X86IrqchipState::deserialize(BorrowedBytesDeserializer::<Error>::new(&bytes)).unwrap();
        *bytes.last_mut().unwrap() = 0x7f;
        let tail =
            X86IrqchipState::deserialize(BorrowedBytesDeserializer::<Error>::new(&bytes)).unwrap();
        assert_eq!(zero, tail);
        let mut ioapic = kvm_ioapic_state::default();
        ioapic.redirtbl[7].bits = 0x71 | (1 << 16) | (3 << 56);
        let mut different_ioapic = same.clone();
        different_ioapic.irqchips[2] = X86IrqchipState::ioapic(ioapic);
        assert_ne!(different_ioapic, same);
    }
}

#[cfg(all(test, target_os = "linux"))]
#[path = "../tests/snapshot/mod.rs"]
mod codec_tests;
