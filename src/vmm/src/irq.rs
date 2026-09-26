// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Device interrupt assignment and routing.
//!
//! HVF and KVM provide the interrupt controller in the kernel (PIC/APIC on
//! x86_64, GICv3 on arm64; WHP (M10) will provide only local APICs), so the
//! VMM emulates none of it. A device raises or lowers its line through
//! [`IrqSender`], which is the named interrupt path from the device model
//! design (`docs/contributing/architecture/vmm/README.md`, "Interrupts").

use std::sync::Arc;

use boxlite_hypervisor::Result;

/// The injection path an [`IrqSender`] drives.
///
/// This is the narrow slice of [`boxlite_hypervisor::Vm`] that devices need.
/// Keeping it separate lets devices be built and tested against a fake
/// without constructing a host VM, and the KVM integration wraps its
/// `Arc<dyn Vm>` in one adapter that implements this trait.
pub trait InterruptTarget: Send + Sync {
    /// Sets interrupt `line` to `level`.
    ///
    /// `line` is a GSI on x86_64 and a GIC SPI INTID (32 and up) on arm64.
    fn set_irq_line(&self, line: u32, level: bool) -> Result<()>;
}

/// A device's handle for raising its interrupt line, safe to clone and hold
/// across worker threads.
#[derive(Clone)]
pub struct IrqSender {
    target: Arc<dyn InterruptTarget>,
}

impl IrqSender {
    /// Wraps a backend's interrupt-injection path.
    pub fn new(target: Arc<dyn InterruptTarget>) -> Self {
        Self { target }
    }

    /// Holds level-triggered line `line` at `level`.
    ///
    /// The 8250 serial is level-triggered: raise on a pending condition and
    /// keep the line high until the guest service clears it.
    pub fn set_level(&self, line: u32, level: bool) -> Result<()> {
        self.target.set_irq_line(line, level)
    }

    /// Pulses edge-triggered line `line`: a set immediately followed by a
    /// clear, which is how the in-kernel controllers spell an edge (design,
    /// "Interrupts").
    ///
    /// If the clear fails after the set succeeded, the error still
    /// propagates: leaving the line high is louder than swallowing it, and
    /// the caller decides what a stuck line costs.
    pub fn trigger_edge(&self, line: u32) -> Result<()> {
        self.target.set_irq_line(line, true)?;
        self.target.set_irq_line(line, false)
    }
}

#[cfg(test)]
mod tests {
    use std::{error::Error as _, io, sync::Mutex};

    use super::*;

    /// Records every `set_irq_line` call, optionally failing one.
    struct RecordingTarget {
        calls: Mutex<Vec<(u32, bool)>>,
        fail_on: Option<(u32, bool)>,
    }

    impl RecordingTarget {
        fn new() -> Self {
            Self {
                calls: Mutex::new(Vec::new()),
                fail_on: None,
            }
        }
    }

    impl InterruptTarget for RecordingTarget {
        fn set_irq_line(&self, line: u32, level: bool) -> Result<()> {
            if self.fail_on == Some((line, level)) {
                return Err(boxlite_hypervisor::Error::SetIrqLine {
                    line,
                    source: io::Error::other("injected"),
                });
            }
            self.calls.lock().unwrap().push((line, level));
            Ok(())
        }
    }

    /// Builds the fake both as a concrete handle (for assertions) and as a
    /// trait object (for the sender).
    fn recorded() -> (Arc<RecordingTarget>, Arc<dyn InterruptTarget>) {
        let target = Arc::new(RecordingTarget::new());
        let shared: Arc<dyn InterruptTarget> = target.clone();
        (target, shared)
    }

    fn failing(line: u32, level: bool) -> (Arc<RecordingTarget>, Arc<dyn InterruptTarget>) {
        let target = Arc::new(RecordingTarget {
            calls: Mutex::new(Vec::new()),
            fail_on: Some((line, level)),
        });
        let shared: Arc<dyn InterruptTarget> = target.clone();
        (target, shared)
    }

    fn calls(target: &RecordingTarget) -> Vec<(u32, bool)> {
        target.calls.lock().unwrap().clone()
    }

    #[test]
    fn set_level_forwards_one_call_per_invocation() {
        let (target, shared) = recorded();
        let sender = IrqSender::new(shared);

        sender.set_level(4, true).unwrap();
        sender.set_level(4, false).unwrap();
        assert_eq!(calls(&target), vec![(4, true), (4, false)]);
    }

    #[test]
    fn edge_is_a_set_followed_by_a_clear() {
        let (target, shared) = recorded();
        let sender = IrqSender::new(shared);

        sender.trigger_edge(5).unwrap();
        assert_eq!(calls(&target), vec![(5, true), (5, false)]);
    }

    #[test]
    fn edge_reports_a_failed_clear_after_a_good_set() {
        let (target, shared) = failing(7, false);
        let sender = IrqSender::new(shared);

        let error = sender.trigger_edge(7).unwrap_err();
        // The set landed, the clear errored, and the host cause propagates.
        assert_eq!(calls(&target), vec![(7, true)]);
        assert_eq!(error.to_string(), "failed to set interrupt line 7");
        let cause = error
            .source()
            .and_then(|cause| cause.downcast_ref::<io::Error>())
            .expect("host cause");
        assert_eq!(cause.to_string(), "injected");
    }

    #[test]
    fn set_failure_short_circuits_before_the_clear() {
        let (target, shared) = failing(9, true);
        let sender = IrqSender::new(shared);

        assert!(sender.trigger_edge(9).is_err());
        assert!(calls(&target).is_empty());
    }

    #[test]
    fn sender_is_clonable_for_device_workers() {
        let (target, shared) = recorded();
        let sender = IrqSender::new(shared);

        sender.clone().set_level(4, true).unwrap();
        assert_eq!(calls(&target), vec![(4, true)]);
    }
}
