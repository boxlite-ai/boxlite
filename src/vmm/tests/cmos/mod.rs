// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The CMOS RTC on a clock the test moves: calendar encoding, the registers,
//! the time-setting sequences Linux uses, and the alarm on its line. The 1999
//! and 2000 vectors are crosvm's (`devices/src/cmos.rs`); the others come
//! from Python's datetime.

use std::{
    sync::{
        Arc,
        atomic::{AtomicI64, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
    },
    time::{Duration, Instant},
};

use super::{AlarmFields, Armed, CmosRtc, host_clock};
use crate::{
    bus::{BusDevice, UNCLAIMED_READ},
    error::Result,
    events::EventLoop,
    irq::{IrqChip, IrqLine},
};

const NANOS: i64 = 1_000_000_000;

/// The indexes of seconds, minutes, hours, weekday, day, month, year and century.
const TIME: [u8; 8] = [0x00, 0x02, 0x04, 0x06, 0x07, 0x08, 0x09, 0x32];

/// Passes every level the RTC sets on its line to the test.
struct Lines(Sender<(u32, bool)>);

impl IrqChip for Lines {
    fn set_line(&self, line: u32, level: bool) -> Result<()> {
        // A test that stopped listening no longer cares.
        let _ = self.0.send((line, level));
        Ok(())
    }
}

/// An RTC on a clock that starts at `seconds` past the epoch, and the levels
/// it sets on its line 8. The line holds the only sender, so the receiver
/// disconnects once the alarm worker has dropped it.
fn rtc_with_line(seconds: i64) -> (CmosRtc, Arc<AtomicI64>, Receiver<(u32, bool)>) {
    let clock = Arc::new(AtomicI64::new(seconds * NANOS));
    let now = Arc::clone(&clock);
    let (levels, changes) = mpsc::channel();
    let line = IrqLine::new(Arc::new(Lines(levels)), 8);
    let events = EventLoop::new().unwrap();
    let rtc = CmosRtc::new(
        Box::new(move || now.load(Ordering::SeqCst)),
        line,
        events.sender(),
    );
    (rtc, clock, changes)
}

/// An RTC on a clock that starts at `seconds` past the epoch.
fn rtc_at(seconds: i64) -> (CmosRtc, Arc<AtomicI64>) {
    let (rtc, clock, _) = rtc_with_line(seconds);
    (rtc, clock)
}

fn advance(clock: &AtomicI64, nanos: i64) {
    clock.fetch_add(nanos, Ordering::SeqCst);
}

fn read(rtc: &mut CmosRtc, index: u8) -> u8 {
    rtc.write(0, &[index]);
    let mut value = [0];
    rtc.read(1, &mut value);
    value[0]
}

fn write(rtc: &mut CmosRtc, index: u8, value: u8) {
    rtc.write(0, &[index]);
    rtc.write(1, &[value]);
}

fn time(rtc: &mut CmosRtc) -> [u8; 8] {
    TIME.map(|index| read(rtc, index))
}

/// The fields Linux writes, in its order: year, month, day, hours, minutes,
/// seconds (`mc146818_set_time`).
type Fields = [u8; 6];

fn write_fields(rtc: &mut CmosRtc, fields: Fields) {
    for (index, value) in [0x09, 0x08, 0x07, 0x04, 0x02, 0x00].into_iter().zip(fields) {
        write(rtc, index, value);
    }
}

/// Linux on Intel: SET, then a divider reset, the fields, register B
/// restored, then register A restored.
fn set_time_intel(rtc: &mut CmosRtc, fields: Fields) {
    let (b, a) = (read(rtc, 0x0b), read(rtc, 0x0a));
    write(rtc, 0x0b, b | 0x80);
    write(rtc, 0x0a, a | 0x70);
    write_fields(rtc, fields);
    write(rtc, 0x0b, b);
    write(rtc, 0x0a, a);
}

/// Linux on AMD: SET, then the bank-select bit cleared instead of a divider
/// reset, the fields, register B restored, then register A restored.
fn set_time_amd(rtc: &mut CmosRtc, fields: Fields) {
    let (b, a) = (read(rtc, 0x0b), read(rtc, 0x0a));
    write(rtc, 0x0b, b | 0x80);
    write(rtc, 0x0a, a & !0x10);
    write_fields(rtc, fields);
    write(rtc, 0x0b, b);
    write(rtc, 0x0a, a);
}

#[test]
fn reads_the_crosvm_vectors_in_bcd() {
    let (mut rtc, _) = rtc_at(946_684_799);
    assert_eq!(
        time(&mut rtc),
        [0x59, 0x59, 0x23, 0x06, 0x31, 0x12, 0x99, 0x19]
    );
    let (mut rtc, _) = rtc_at(946_684_800);
    assert_eq!(
        time(&mut rtc),
        [0x00, 0x00, 0x00, 0x07, 0x01, 0x01, 0x00, 0x20]
    );
}

#[test]
fn follows_the_gregorian_leap_rules_and_times_before_the_epoch() {
    for (seconds, expected) in [
        // 2000-02-29, a Tuesday: 2000 is a leap year.
        (
            951_782_400,
            [0x00, 0x00, 0x00, 0x03, 0x29, 0x02, 0x00, 0x20],
        ),
        // 2100-02-28 23:59:59, a Sunday, then 2100-03-01: 2100 is not.
        (
            4_107_542_399,
            [0x59, 0x59, 0x23, 0x01, 0x28, 0x02, 0x00, 0x21],
        ),
        (
            4_107_542_400,
            [0x00, 0x00, 0x00, 0x02, 0x01, 0x03, 0x00, 0x21],
        ),
        // 1969-12-31 23:59:59, a Wednesday.
        (-1, [0x59, 0x59, 0x23, 0x04, 0x31, 0x12, 0x69, 0x19]),
    ] {
        let (mut rtc, _) = rtc_at(seconds);
        assert_eq!(time(&mut rtc), expected, "at {seconds}");
    }
}

#[test]
fn rolls_over_into_the_next_day() {
    // 2026-01-02 23:59:59, a Friday.
    let (mut rtc, clock) = rtc_at(1_767_398_399);
    assert_eq!(
        time(&mut rtc),
        [0x59, 0x59, 0x23, 0x06, 0x02, 0x01, 0x26, 0x20]
    );
    advance(&clock, NANOS);
    assert_eq!(
        time(&mut rtc),
        [0x00, 0x00, 0x00, 0x07, 0x03, 0x01, 0x26, 0x20]
    );
}

#[test]
fn binary_mode_reads_and_sets_plain_numbers() {
    let (mut rtc, _) = rtc_at(946_684_799);
    write(&mut rtc, 0x0b, 0x06);
    assert_eq!(time(&mut rtc), [59, 59, 23, 6, 31, 12, 99, 19]);

    // 2030-05-06 07:08:09, a Monday, written in binary.
    set_time_intel(&mut rtc, [30, 5, 6, 7, 8, 9]);
    assert_eq!(time(&mut rtc), [9, 8, 7, 2, 6, 5, 30, 20]);
}

#[test]
fn status_registers_keep_their_fixed_bits() {
    let status = |rtc: &mut CmosRtc| [0x0a, 0x0b, 0x0c, 0x0d].map(|index| read(rtc, index));
    let (mut rtc, _) = rtc_at(0);
    assert_eq!(status(&mut rtc), [0x26, 0x02, 0x00, 0x80]);

    write(&mut rtc, 0x0a, 0xa6); // UIP is read-only
    write(&mut rtc, 0x0b, 0x00); // 12-hour mode is not modelled
    write(&mut rtc, 0x0c, 0xff);
    write(&mut rtc, 0x0d, 0x00);

    assert_eq!(status(&mut rtc), [0x26, 0x02, 0x00, 0x80]);
}

#[test]
fn a_time_set_the_linux_way_ticks_half_a_second_after_release() {
    let sequences: [fn(&mut CmosRtc, Fields); 2] = [set_time_intel, set_time_amd];
    for set_time in sequences {
        let (mut rtc, clock) = rtc_at(1_767_323_045);
        // 2030-05-06 07:08:09, a Monday.
        set_time(&mut rtc, [0x30, 0x05, 0x06, 0x07, 0x08, 0x09]);
        assert_eq!(
            time(&mut rtc),
            [0x09, 0x08, 0x07, 0x02, 0x06, 0x05, 0x30, 0x20]
        );

        advance(&clock, NANOS / 2 - 1_000_000);
        assert_eq!(read(&mut rtc, 0x00), 0x09, "1 ms before the next second");
        advance(&clock, 2_000_000);
        assert_eq!(read(&mut rtc, 0x00), 0x10, "1 ms into the next second");
    }
}

#[test]
fn the_registers_hold_still_while_set_is_on() {
    let (mut rtc, clock) = rtc_at(946_684_799);
    write(&mut rtc, 0x0b, 0x82);
    advance(&clock, 5 * NANOS);
    assert_eq!(
        time(&mut rtc),
        [0x59, 0x59, 0x23, 0x06, 0x31, 0x12, 0x99, 0x19]
    );

    write(&mut rtc, 0x0b, 0x02);
    assert_eq!(read(&mut rtc, 0x00), 0x59, "the held time resumes");
    advance(&clock, NANOS / 2);
    assert_eq!(
        time(&mut rtc),
        [0x00, 0x00, 0x00, 0x07, 0x01, 0x01, 0x00, 0x20]
    );
}

#[test]
fn a_write_while_running_takes_effect_at_once_within_the_same_second() {
    let (mut rtc, clock) = rtc_at(946_684_799);
    advance(&clock, NANOS * 3 / 4);

    write(&mut rtc, 0x02, 0x30);
    assert_eq!(time(&mut rtc)[..3], [0x59, 0x30, 0x23]);
    advance(&clock, NANOS / 4);
    assert_eq!(time(&mut rtc)[..3], [0x00, 0x31, 0x23]);
}

#[test]
fn an_impossible_time_leaves_the_clock_alone() {
    let (mut rtc, clock) = rtc_at(946_684_799);
    write(&mut rtc, 0x0b, 0x82);
    write(&mut rtc, 0x00, 0x60); // second 60
    write(&mut rtc, 0x0b, 0x02);
    advance(&clock, NANOS);
    assert_eq!(
        time(&mut rtc),
        [0x00, 0x00, 0x00, 0x07, 0x01, 0x01, 0x00, 0x20]
    );

    write(&mut rtc, 0x02, 0x7a); // not BCD
    assert_eq!(read(&mut rtc, 0x02), 0x00);
}

#[test]
fn two_digit_years_pivot_at_70_unless_the_guest_writes_the_century() {
    let (mut rtc, _) = rtc_at(0);
    set_time_intel(&mut rtc, [0x69, 0x01, 0x01, 0x00, 0x00, 0x00]);
    assert_eq!([read(&mut rtc, 0x09), read(&mut rtc, 0x32)], [0x69, 0x20]);
    set_time_intel(&mut rtc, [0x70, 0x01, 0x01, 0x00, 0x00, 0x00]);
    assert_eq!([read(&mut rtc, 0x09), read(&mut rtc, 0x32)], [0x70, 0x19]);

    write(&mut rtc, 0x0b, 0x82);
    write(&mut rtc, 0x32, 0x21);
    write(&mut rtc, 0x09, 0x05);
    write(&mut rtc, 0x0b, 0x02);
    // 2105-01-01, a Thursday.
    assert_eq!(
        time(&mut rtc),
        [0x00, 0x00, 0x00, 0x05, 0x01, 0x01, 0x05, 0x21]
    );
}

#[test]
fn a_day_past_the_month_end_runs_into_the_next_month() {
    let (mut rtc, _) = rtc_at(0);
    set_time_amd(&mut rtc, [0x01, 0x02, 0x31, 0x00, 0x00, 0x00]);
    // 2001-02-31 is 2001-03-03, a Saturday.
    assert_eq!(
        time(&mut rtc),
        [0x00, 0x00, 0x00, 0x07, 0x03, 0x03, 0x01, 0x20]
    );
}

#[test]
fn other_bytes_are_ram_and_odd_accesses_are_unclaimed() {
    let (mut rtc, _) = rtc_at(0);
    write(&mut rtc, 0x0e, 0xab);
    write(&mut rtc, 0x7f, 0xcd);
    write(&mut rtc, 0x01, 0x30); // the alarm seconds are plain storage
    assert_eq!(
        [0x0e, 0x7f, 0x01].map(|index| read(&mut rtc, index)),
        [0xab, 0xcd, 0x30]
    );
    // Bit 7 of the index masks NMI on a PC and selects nothing.
    assert_eq!(read(&mut rtc, 0x8e), 0xab);

    let mut index_port = [0];
    rtc.read(0, &mut index_port);
    let mut wide = [0; 2];
    rtc.read(1, &mut wide);
    rtc.write(1, &[0x11, 0x22]);

    assert_eq!(index_port, [UNCLAIMED_READ]);
    assert_eq!(wide, [UNCLAIMED_READ; 2]);
    assert_eq!(read(&mut rtc, 0x0e), 0xab, "a wide write changes nothing");
}

#[test]
fn the_host_clock_counts_unix_nanoseconds() {
    let seconds = host_clock() / NANOS;
    // Between 2026-01-01 and 2100-01-01.
    assert!(
        (1_767_225_600..4_102_444_800).contains(&seconds),
        "{seconds}"
    );
}

#[test]
fn the_next_alarm_match_honours_wildcards_and_wraps_the_day() {
    let at = |hour: i64, minute: i64, second: i64| hour * 3600 + minute * 60 + second;
    let alarm = |second, minute, hour| AlarmFields {
        second,
        minute,
        hour,
    };
    // Midnight from 23:59:59 is one second ahead, across the day.
    let midnight = alarm(Some(0), Some(0), Some(0));
    assert_eq!(midnight.seconds_to_next_match(at(23, 59, 59)), 1);
    // Every field "don't care": every second.
    assert_eq!(
        alarm(None, None, None).seconds_to_next_match(at(12, 0, 0)),
        1
    );
    // Second 30 of any minute, from 12:00:45.
    let second_30 = alarm(Some(30), None, None);
    assert_eq!(second_30.seconds_to_next_match(at(12, 0, 45)), 45);
    // Any second of 13:00: next second while in it, the next day after it.
    let at_13_00 = alarm(None, Some(0), Some(13));
    assert_eq!(at_13_00.seconds_to_next_match(at(13, 0, 30)), 1);
    assert_eq!(at_13_00.seconds_to_next_match(at(13, 0, 59)), 86_341);
    // An alarm on the current second alone is a day away.
    let now = alarm(Some(5), Some(4), Some(3));
    assert_eq!(now.seconds_to_next_match(at(3, 4, 5)), 86_400);
}

#[test]
fn an_alarm_raises_line_8_and_reports_itself_once_in_register_c() {
    // 1999-12-31 23:59:59, with the alarm at 00:00:00, a second ahead.
    let (mut rtc, _, changes) = rtc_with_line(946_684_799);
    for index in [0x01, 0x03, 0x05] {
        write(&mut rtc, index, 0x00);
    }
    write(&mut rtc, 0x0b, 0x22); // AIE, 24-hour mode

    let wait = Duration::from_secs(5);
    assert_eq!(changes.recv_timeout(wait), Ok((8, true)));
    assert_eq!(changes.recv_timeout(wait), Ok((8, false)));
    assert_eq!(read(&mut rtc, 0x0c), 0xa0, "IRQF and AF");
    assert_eq!(read(&mut rtc, 0x0c), 0x00, "reading register C clears it");
}

#[test]
fn clearing_aie_disarms_the_alarm() {
    // Half a second into 00:00:00, with every alarm field "don't care".
    let (mut rtc, clock, changes) = rtc_with_line(0);
    advance(&clock, NANOS / 2);
    for index in [0x01, 0x03, 0x05] {
        write(&mut rtc, index, 0xff);
    }
    write(&mut rtc, 0x0b, 0x22);
    let wait = Duration::from_secs(5);
    assert_eq!(changes.recv_timeout(wait), Ok((8, true)));
    assert_eq!(changes.recv_timeout(wait), Ok((8, false)));

    write(&mut rtc, 0x0b, 0x02);
    // Still armed, the alarm would fire again one second after the first.
    assert_eq!(
        changes.recv_timeout(Duration::from_millis(1500)),
        Err(RecvTimeoutError::Timeout)
    );
    assert_eq!(
        read(&mut rtc, 0x0c),
        0x20,
        "AF without IRQF once AIE is off"
    );
}

#[test]
fn a_late_worker_coalesces_missed_matches_into_one() {
    // An every-second alarm due at second 10 of the day, woken 3.5 s late.
    let now = Instant::now();
    let mut armed = Armed {
        deadline: now - Duration::from_millis(3500),
        second_of_day: 10,
        fields: AlarmFields {
            second: None,
            minute: None,
            hour: None,
        },
    };
    armed.advance_past(now);
    // Matches 11 to 13 are already past; the next one is still ahead.
    assert_eq!(armed.second_of_day, 14);
    assert_eq!(armed.deadline, now + Duration::from_millis(500));
}

#[test]
fn dropping_the_rtc_stops_and_joins_its_alarm_worker() {
    // At 00:00:00 the zeroed alarm registers match only now: a day away.
    let (mut rtc, _, changes) = rtc_with_line(0);
    write(&mut rtc, 0x0b, 0x22);

    drop(rtc);
    // The worker held the line's only sender, so the channel disconnects once
    // it has returned; a worker still waiting for its alarm keeps it open.
    assert_eq!(
        changes.recv_timeout(Duration::from_secs(5)),
        Err(RecvTimeoutError::Disconnected)
    );
}
