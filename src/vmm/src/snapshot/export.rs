// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{path::PathBuf, sync::mpsc};

use boxlite_hypervisor::X86Vm;

use super::image;
use crate::{Result, lifecycle::Lifecycle, memory::GuestRam};

#[derive(Debug)]
pub(crate) struct Request {
    pub(crate) state_path: PathBuf,
    pub(crate) memory_path: PathBuf,
    pub(crate) reply: mpsc::Sender<Result<()>>,
}

pub(crate) fn drive(lifecycle: &Lifecycle, host: &impl X86Vm, ram: &GuestRam, count: u8) {
    let Some((request, machine)) = lifecycle.advance_export(host, count) else {
        return;
    };
    let result = machine.and_then(|mut state| {
        state.vcpus.sort_unstable_by_key(|record| record.id);
        lifecycle.check_export()?;
        let mut state_file = image::create_new_file(&request.state_path)?;
        let mut memory_file = image::create_new_file(&request.memory_path)?;
        image::write_to_checked(
            &mut state_file,
            &mut memory_file,
            state.vcpus.len() as u32,
            &state.encode()?,
            ram,
            || lifecycle.check_export(),
        )
    });
    let _ = request.reply.send(lifecycle.finish_export(result));
}
