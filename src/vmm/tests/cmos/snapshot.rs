// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The RTC's snapshot operations on a clock the test moves: stopping the alarm
//! thread, saving without side effects, restoring after validation, and the
//! single IRQ 8 edge an alarm that fell due while paused gets on resume.

use std::{
    sync::{
        Arc,
        atomic::{AtomicI64, AtomicUsize, Ordering},
        mpsc::{self, Receiver, TryRecvError},
    },
    thread,
    time::Duration,
};

use super::super::{Armed, Clock, CmosRtcState, SNAPSHOT_FORMAT, SNAPSHOT_VERSION};
use super::*;
use crate::{
    error::Result,
    events::{Event, EventLoop},
    irq::{IrqChip, IrqLine},
    virtio::{DeviceError, DeviceSnapshot, RestoreContext},
};

/// How long a test waits for the alarm thread, which never needs this long.
const WAIT: Duration = Duration::from_secs(5);

fn no_level_change(changes: &Receiver<(u32, bool)>) -> bool {
    changes.try_recv() == Err(TryRecvError::Empty)
}

/// An RTC on line 8 with the alarm at 00:00:01, paused as soon as the guest
/// configured it, and a clock one second past that alarm.
fn paused_past_the_alarm(aie: bool) -> (CmosRtc, Arc<AtomicI64>, Receiver<(u32, bool)>) {
    let (mut rtc, clock, changes) = rtc_with_line(0);
    write(&mut rtc, 0x01, 0x01);
    if aie {
        write(&mut rtc, 0x0b, 0x22);
    }
    rtc.quiesce().unwrap();
    advance(&clock, NANOS);
    (rtc, clock, changes)
}

/// An RTC on line 8 that fails its first raise, one nanosecond before
/// 00:00:01, with its clock, the number of raises attempted and the loop
/// that reports the failure.
fn rtc_with_broken_line() -> (CmosRtc, Arc<AtomicI64>, Arc<AtomicUsize>, EventLoop) {
    struct BrokenLine(Arc<AtomicUsize>);
    impl IrqChip for BrokenLine {
        fn set_line(&self, line: u32, level: bool) -> Result<()> {
            assert_eq!((line, level), (8, true));
            self.0.fetch_add(1, Ordering::SeqCst);
            Err(crate::error::Error::Hypervisor(
                boxlite_hypervisor::Error::SetIrqLine {
                    line,
                    source: std::io::Error::from_raw_os_error(5),
                },
            ))
        }
    }
    let raises = Arc::new(AtomicUsize::new(0));
    let chip = Arc::new(BrokenLine(Arc::clone(&raises)));
    let events = EventLoop::new().unwrap();
    let clock = Arc::new(AtomicI64::new(NANOS - 1));
    let now = Arc::clone(&clock);
    let rtc = CmosRtc::new(
        Box::new(move || now.load(Ordering::SeqCst)),
        IrqLine::new(chip.clone(), 8),
        events.sender(),
    );
    (rtc, clock, raises, events)
}

/// The state the RTC wrote into `snapshot`.
fn decoded(snapshot: &DeviceSnapshot) -> CmosRtcState {
    postcard::from_bytes(&snapshot.payload).unwrap()
}

/// A snapshot of `state`, written the way the RTC writes it.
fn encoded(state: &CmosRtcState) -> DeviceSnapshot {
    DeviceSnapshot {
        format: SNAPSHOT_FORMAT,
        version: SNAPSHOT_VERSION,
        payload: postcard::to_allocvec(state).unwrap(),
    }
}

/// `saved` with one field changed.
fn edited(saved: &DeviceSnapshot, edit: impl FnOnce(&mut CmosRtcState)) -> DeviceSnapshot {
    let mut state = decoded(saved);
    edit(&mut state);
    encoded(&state)
}

/// A pending alarm with these fields, armed at 00:00:00.
fn alarm(second: Option<i64>, minute: Option<i64>, hour: Option<i64>) -> Option<Armed> {
    Some(Armed::after(
        AlarmFields {
            second,
            minute,
            hour,
        },
        0,
    ))
}

/// The parts of an RTC a rejected restore must leave alone.
#[derive(Debug, PartialEq)]
struct Observed {
    selected: usize,
    registers: [u8; 128],
    offset_from_clock: i64,
    armed: Option<Armed>,
    matched: bool,
    aie: bool,
    paused: bool,
}

fn observe(rtc: &CmosRtc) -> Observed {
    let state = rtc.alarm.state();
    Observed {
        selected: rtc.selected,
        registers: rtc.registers,
        offset_from_clock: state.offset_from_clock,
        armed: state.armed,
        matched: state.matched,
        aie: state.aie,
        paused: state.paused,
    }
}

#[test]
fn a_paused_rtc_latches_a_late_alarm_only_once_read() {
    let (mut rtc, _, changes) = paused_past_the_alarm(true);
    assert!(rtc.worker.is_none(), "quiesce joined the alarm thread");
    assert!(no_level_change(&changes));

    assert_eq!(
        read(&mut rtc, 0x0c),
        0xa0,
        "reading C settles the overdue match"
    );
    assert!(no_level_change(&changes));
    assert!(
        rtc.worker.is_none(),
        "a port access does not restart the thread"
    );
}

#[test]
fn quiesce_twice_changes_nothing() {
    let (mut rtc, _, changes) = paused_past_the_alarm(true);
    let before = observe(&rtc);
    assert!(before.paused);

    rtc.quiesce().unwrap();
    assert_eq!(observe(&rtc), before);
    assert!(no_level_change(&changes));
}

#[test]
fn quiesce_fails_after_the_alarm_thread_panicked() {
    let now = Arc::new(AtomicI64::new(0));
    let (broken, broke) = mpsc::channel();
    let reads = Arc::clone(&now);
    let clock: Clock = Box::new(move || {
        if thread::current().name() == Some("cmos-alarm") {
            let _ = broken.send(());
            panic!("the alarm thread's clock broke");
        }
        reads.load(Ordering::SeqCst)
    });
    let events = EventLoop::new().unwrap();
    let (levels, _) = mpsc::channel();
    let mut rtc = CmosRtc::new(
        clock,
        IrqLine::new(Arc::new(Lines(levels)), 8),
        events.sender(),
    );
    write(&mut rtc, 0x01, 0xff); // any second: the worker starts and reads the clock
    broke.recv_timeout(WAIT).unwrap();

    assert_eq!(
        rtc.quiesce(),
        Err(DeviceError::Fatal("joining the CMOS RTC alarm thread"))
    );
}

#[test]
fn resume_raises_line_8_once_for_an_alarm_that_fell_due_while_paused() {
    let (mut rtc, _, changes) = paused_past_the_alarm(true);
    rtc.resume().unwrap();
    assert_eq!(changes.recv_timeout(WAIT), Ok((8, true)));
    assert!(no_level_change(&changes));
    assert_eq!(read(&mut rtc, 0x0c), 0xa0);
    assert_eq!(read(&mut rtc, 0x0c), 0x00);
    assert_eq!(changes.recv_timeout(WAIT), Ok((8, false)));
}

#[test]
fn resume_restarts_the_alarm_thread_for_an_alarm_still_ahead() {
    let (mut rtc, clock, changes) = rtc_with_line(0);
    write(&mut rtc, 0x01, 0x01);
    write(&mut rtc, 0x0b, 0x22);
    rtc.quiesce().unwrap();
    rtc.resume().unwrap();
    assert!(no_level_change(&changes));

    advance(&clock, NANOS);
    assert_eq!(changes.recv_timeout(WAIT), Ok((8, true)));
}

#[test]
fn resume_twice_raises_no_extra_edge() {
    let (mut rtc, _, changes) = paused_past_the_alarm(true);
    rtc.resume().unwrap();
    rtc.resume().unwrap();
    assert_eq!(changes.recv_timeout(WAIT), Ok((8, true)));
    assert!(no_level_change(&changes));
}

#[test]
fn resume_fails_once_the_device_has_stopped() {
    let (mut rtc, clock, raises, mut events) = rtc_with_broken_line();
    write(&mut rtc, 0x01, 0xff); // any second: the first match fails on the line
    write(&mut rtc, 0x0b, 0x22);
    advance(&clock, 1);
    assert!(matches!(
        events.wait(Some(WAIT)).unwrap(),
        Some(Event::DeviceFailed(_))
    ));

    assert_eq!(
        rtc.resume(),
        Err(DeviceError::Fatal("resuming the CMOS RTC"))
    );
    assert_eq!(raises.load(Ordering::SeqCst), 1, "IRQ 8 did not change");
}

#[test]
fn resume_fails_when_raising_line_8_fails() {
    let (mut rtc, clock, raises, mut events) = rtc_with_broken_line();
    write(&mut rtc, 0x01, 0x01);
    write(&mut rtc, 0x0b, 0x22);
    rtc.quiesce().unwrap();
    advance(&clock, NANOS);

    assert_eq!(
        rtc.resume(),
        Err(DeviceError::Fatal("resuming the CMOS RTC"))
    );
    assert!(matches!(
        events.wait(Some(WAIT)).unwrap(),
        Some(Event::DeviceFailed(_))
    ));
    assert_eq!(raises.load(Ordering::SeqCst), 1);
}

#[test]
fn saving_is_stable_and_leaves_register_c_and_line_8_alone() {
    let (mut rtc, _, changes) = paused_past_the_alarm(true);
    write(&mut rtc, 0x0b, 0x22); // a port write settles the overdue match
    assert_eq!(changes.recv_timeout(WAIT), Ok((8, true)));
    let before = observe(&rtc);

    let first = rtc.save_state().unwrap();
    let second = rtc.save_state().unwrap();
    assert_eq!((first.format, first.version), (1, 1));
    assert_eq!(first, second);
    assert_eq!(decoded(&first).registers[0x0c], 0xa0, "AF with AIE on");
    assert_eq!(observe(&rtc), before);

    assert_eq!(read(&mut rtc, 0x0c), 0xa0, "the flags survive the save");
    assert_eq!(read(&mut rtc, 0x0c), 0x00);
    assert_eq!(changes.recv_timeout(WAIT), Ok((8, false)));
}

#[test]
fn saving_a_disabled_alarm_carries_af_without_irqf() {
    let (mut rtc, _, changes) = paused_past_the_alarm(false);
    write(&mut rtc, 0x0b, 0x02); // a port write settles the overdue match
    assert!(no_level_change(&changes));

    let saved = rtc.save_state().unwrap();
    assert_eq!(decoded(&saved).registers[0x0c], 0x20);
}

#[test]
fn saving_keeps_the_guest_time_and_the_alarm() {
    let (mut rtc, _, _) = rtc_with_line(0);
    // 2030-05-06 07:08:09, with the alarm at 00:00:30.
    set_time_intel(&mut rtc, [0x30, 0x05, 0x06, 0x07, 0x08, 0x09]);
    write(&mut rtc, 0x01, 0x30);
    rtc.quiesce().unwrap();
    let before = observe(&rtc);

    let saved = rtc.save_state().unwrap();
    let state = decoded(&saved);
    assert_eq!(state.selected, u8::try_from(before.selected).unwrap());
    assert_eq!(state.registers, before.registers);
    assert_eq!(state.offset_from_clock, before.offset_from_clock);
    assert_eq!(state.armed, before.armed);
}

#[test]
fn a_restored_rtc_saves_the_same_snapshot() {
    let (mut rtc, _, _) = rtc_with_line(0);
    set_time_intel(&mut rtc, [0x30, 0x05, 0x06, 0x07, 0x08, 0x09]);
    write(&mut rtc, 0x01, 0x30);
    write(&mut rtc, 0x0b, 0x22);
    write(&mut rtc, 0x0e, 0xab); // NVRAM
    rtc.write(0, &[0x0e]); // the guest selected register 0x0E and has not read it
    rtc.quiesce().unwrap();
    let snapshot = rtc.save_state().unwrap();

    let (mut restored, _, changes) = rtc_with_line(946_684_800);
    restored
        .restore_state(snapshot.clone(), RestoreContext)
        .unwrap();
    assert!(no_level_change(&changes));
    assert!(restored.worker.is_none(), "a restored RTC is paused");
    assert_eq!(restored.save_state().unwrap(), snapshot);
}

#[test]
fn resume_does_not_raise_again_for_an_af_latched_before_the_pause() {
    let (mut rtc, _, _) = paused_past_the_alarm(true);
    write(&mut rtc, 0x0b, 0x22); // a port write settles the overdue match
    let snapshot = rtc.save_state().unwrap();

    let (mut restored, _, changes) = rtc_with_line(0);
    restored.restore_state(snapshot, RestoreContext).unwrap();
    restored.resume().unwrap();
    assert!(no_level_change(&changes));
    assert_eq!(read(&mut restored, 0x0c), 0xa0);
    assert_eq!(read(&mut restored, 0x0c), 0x00);
    assert!(no_level_change(&changes), "the line was never raised");
}

#[test]
fn restore_rejects_a_damaged_snapshot_and_changes_nothing() {
    // An RTC with content, IRQ 8 high: a guest time, NVRAM, register 0x0E
    // selected, and an alarm that fell due with AIE on.
    let (mut rtc, clock, changes) = rtc_with_line(0);
    set_time_intel(&mut rtc, [0x30, 0x05, 0x06, 0x07, 0x08, 0x09]);
    write(&mut rtc, 0x0e, 0xab);
    rtc.write(0, &[0x0e]);
    rtc.quiesce().unwrap();
    let saved = rtc.save_state().unwrap();
    advance(&clock, 86_400 * NANOS);
    write(&mut rtc, 0x0b, 0x22); // a port write settles the overdue match
    assert_eq!(changes.recv_timeout(WAIT), Ok((8, true)));

    let mut other_format = saved.clone();
    other_format.format += 1;
    let mut other_version = saved.clone();
    other_version.version += 1;
    let mut short = saved.clone();
    short.payload.pop();
    let mut long = saved.clone();
    long.payload.push(0);
    let decode_error = || DeviceError::Fatal("decoding the CMOS RTC snapshot");
    let fields_error = || DeviceError::Fatal("checking the CMOS RTC snapshot fields");
    let damaged_fields = [
        (Some(60), Some(0), Some(0)),
        (Some(0), Some(60), Some(0)),
        (Some(0), Some(0), Some(24)),
        (Some(-1), Some(0), Some(0)),
        (Some(0), Some(-1), Some(0)),
        (Some(0), Some(0), Some(-1)),
    ]
    .map(|(second, minute, hour)| {
        edited(&saved, |state| state.armed = alarm(second, minute, hour))
    });
    let rejected = [
        (
            other_format,
            DeviceError::Fatal("checking the CMOS RTC snapshot format"),
        ),
        (
            other_version,
            DeviceError::Fatal("checking the CMOS RTC snapshot version"),
        ),
        (short, decode_error()),
        (long, decode_error()),
        (edited(&saved, |state| state.selected = 128), fields_error()),
    ]
    .into_iter()
    .chain(damaged_fields.map(|snapshot| (snapshot, fields_error())));

    let before = observe(&rtc);
    for (snapshot, error) in rejected {
        assert_eq!(rtc.restore_state(snapshot, RestoreContext), Err(error));
        assert_eq!(observe(&rtc), before);
    }
    assert!(no_level_change(&changes));
}

#[test]
fn restore_accepts_the_last_register_and_the_alarm_boundaries() {
    let (paused, _, _) = paused_past_the_alarm(true);
    let saved = paused.save_state().unwrap();
    let (mut restored, _, _) = rtc_with_line(0);

    let last = edited(&saved, |state| {
        state.selected = 127;
        state.registers[127] = 0xab;
        state.armed = alarm(Some(59), Some(59), Some(23));
    });
    restored.restore_state(last, RestoreContext).unwrap();
    let mut value = [0];
    restored.read(1, &mut value);
    assert_eq!(
        value,
        [0xab],
        "the next data-port access lands on register 127"
    );
    assert_eq!(
        observe(&restored).armed,
        alarm(Some(59), Some(59), Some(23))
    );

    let wildcard = edited(&saved, |state| state.armed = alarm(None, None, None));
    restored.restore_state(wildcard, RestoreContext).unwrap();
    assert_eq!(observe(&restored).armed, alarm(None, None, None));
}

#[test]
fn a_snapshot_holds_the_version_1_layout() {
    let (mut rtc, _, _) = rtc_with_line(0);
    rtc.quiesce().unwrap();
    let saved = rtc.save_state().unwrap();
    // A new RTC at 00:00:00: register 0 selected, then the 128 CMOS bytes
    // behind their varint length, with status A, B and D at power-on. Then
    // no offset, and the midnight alarm a day out, observed at second zero.
    let mut registers = [0; 128];
    registers[0x0a] = 0x26;
    registers[0x0b] = 0x02;
    registers[0x0d] = 0x80;
    let mut expected = vec![0x00, 0x80, 0x01];
    expected.extend(registers);
    expected.extend([
        0x00, // offset_from_clock
        0x01, 0x80, 0xc6, 0x0a, 0x00, // armed: target 86400, observed 0
        0x01, 0x00, 0x01, 0x00, 0x01, 0x00, // second, minute and hour 0
    ]);
    assert_eq!(saved.payload, expected);
}
