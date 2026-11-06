// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! Wire packets, captured guest buffers and registered Unix sources for vsock.

mod buffer;
mod packet;
mod source;

fn bad_queue() -> crate::virtio::DeviceError {
    crate::virtio::DeviceError::NeedsReset("vsock descriptor queue")
}

#[cfg(test)]
#[path = "../../../tests/vsock/layers.rs"]
mod tests;
