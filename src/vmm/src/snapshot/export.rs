// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{path::PathBuf, sync::mpsc};

use boxlite_hypervisor::X86Vm;

use super::{
    image::{self, NewFileWriter},
    state::{MachineState, VcpuRecord},
};
use crate::{Result, lifecycle::Lifecycle, memory::GuestRam};

pub(crate) struct Request {
    pub(crate) state_path: PathBuf,
    pub(crate) memory_path: PathBuf,
    pub(crate) reply: mpsc::Sender<Result<()>>,
}

pub(crate) fn drive(lifecycle: &Lifecycle, host: &impl X86Vm, ram: &GuestRam, count: u8) {
    if let Some((request, replies)) = lifecycle.advance_export(count) {
        let result = write_snapshot(&request, lifecycle, host, ram, replies);
        let _ = request.reply.send(lifecycle.finish_export(result));
    }
}

fn write_snapshot<'a>(
    request: &'a Request,
    lifecycle: &Lifecycle,
    host: &impl X86Vm,
    ram: &GuestRam,
    replies: Vec<Result<VcpuRecord>>,
) -> Result<[NewFileWriter<'a>; 2]> {
    let check = || lifecycle.check_export();
    let mut vcpus = replies.into_iter().collect::<Result<Vec<_>>>()?;
    vcpus.sort_unstable_by_key(|record| record.id);
    check()?;
    let state = MachineState {
        vcpus,
        platform: host.save_state()?,
    };
    check()?;
    let mut state_file = NewFileWriter::new(&request.state_path)?;
    let mut memory_file = NewFileWriter::new(&request.memory_path)?;
    image::write(&mut state_file, &mut memory_file, &state, ram, check)?;
    Ok([state_file, memory_file])
}
