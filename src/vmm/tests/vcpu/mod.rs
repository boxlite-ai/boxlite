// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

use std::{sync::Barrier, thread};

use boxlite_hypervisor::{Arm64BootRegisters, CpuOnResult};

use super::{PSTATE_EL1H_DAIF, PowerStates};
use crate::events::{Event, EventLoop};

#[test]
fn concurrent_cpu_on_calls_reserve_one_start_with_its_own_registers() {
    let power = PowerStates::new(17);
    let barrier = Barrier::new(8);
    let results = thread::scope(|scope| {
        let handles: Vec<_> = (0..8)
            .map(|context_id| {
                let power = &power;
                let barrier = &barrier;
                scope.spawn(move || {
                    let entry = 0x8020_0000 + context_id * 4;
                    barrier.wait();
                    (power.start(0x100, entry, context_id), entry, context_id)
                })
            })
            .collect();
        handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>()
    });
    let successful: Vec<_> = results
        .iter()
        .filter(|(result, _, _)| *result == CpuOnResult::Success)
        .collect();
    assert_eq!(successful.len(), 1, "{results:?}");
    assert_eq!(
        results
            .iter()
            .filter(|(result, _, _)| *result == CpuOnResult::AlreadyOn)
            .count(),
        7
    );

    let events = EventLoop::new().unwrap();
    let (_, entry, context_id) = *successful[0];
    assert_eq!(
        power.wait_for_start(16, &events.sender()),
        Some(Arm64BootRegisters {
            pc: entry,
            x0: context_id,
            pstate: PSTATE_EL1H_DAIF
        })
    );
    assert_eq!(
        power.start(0x100, entry, context_id),
        CpuOnResult::AlreadyOn
    );
}

#[test]
fn stopping_discards_a_start_that_the_secondary_has_not_taken() {
    let power = PowerStates::new(2);
    let events = EventLoop::new().unwrap();
    assert_eq!(power.start(1, 0x8020_0000, 7), CpuOnResult::Success);
    events.sender().send(Event::StopRequested);
    assert_eq!(power.wait_for_start(1, &events.sender()), None);
}
