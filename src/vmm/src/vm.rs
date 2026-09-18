// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! VM event-loop sketch. Names are provisional; no execution is implemented.
//!
//! Workers are already running; each reports its result as `VcpuExited`.
//!
//! ```text
//! let outcome = loop {
//!     match events.wait() {
//!         Ok(VmEvent::DeviceReady(id)) => {
//!             if let Err(error) = devices.process(id) {
//!                 break Err(error);
//!             }
//!         }
//!         Ok(VmEvent::StopRequested) => break Ok(VmExit::StopRequested),
//!         Ok(VmEvent::VcpuExited(outcome)) => break outcome,
//!         Err(error) => break Err(error),
//!     }
//! };
//! vcpus.request_stop();
//! vcpus.kick_all();
//! let joined = vcpus.join_all();
//! outcome.and_then(|exit| joined.map(|()| exit))
//! ```
//!
//! Every exit path stops, wakes, and joins all vCPUs before releasing VM resources.
//! `join_all` waits for every worker even if one failed; preserve the original error.
