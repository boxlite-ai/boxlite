// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! vCPU run-loop sketch. Names are provisional; no execution is implemented.
//!
//! ```text
//! loop {
//!     if stop.is_requested() {
//!         return Ok(VmExit::StopRequested);
//!     }
//!     match vcpu.run()? {
//!         VcpuExit::MmioRead { address, bytes } => {
//!             bus.read(address, bytes)?;
//!             vcpu.complete_io()?;
//!         }
//!         VcpuExit::MmioWrite { address, bytes } => {
//!             bus.write(address, bytes)?;
//!             vcpu.complete_io()?;
//!         }
//!         VcpuExit::Interrupted => continue,
//!         VcpuExit::Halted => wait_for_irq_or_stop()?,
//!         VcpuExit::Shutdown => return Ok(VmExit::GuestShutdown),
//!         VcpuExit::Reset => return Ok(VmExit::GuestReset),
//!     }
//! }
//! ```
//!
//! Complete serviced I/O before observing stop on the next iteration. Halting
//! waits for a wakeup; it is not guest shutdown. Errors propagate to the caller.
