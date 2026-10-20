// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The CMOS RTC on a clock the test moves: calendar encoding, the registers,
//! and the time-setting sequences Linux uses. The 1999 and 2000 vectors are
//! crosvm's (`devices/src/cmos.rs`); the others come from Python's datetime.

use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};

use super::{CmosRtc, host_clock};
use crate::bus::{BusDevice, UNCLAIMED_READ};

const NANOS: i64 = 1_000_000_000;

/// The indexes of seconds, minutes, hours, weekday, day, month, year and century.
const TIME: [u8; 8] = [0x00, 0x02, 0x04, 0x06, 0x07, 0x08, 0x09, 0x32];

/// An RTC on a clock that starts at `seconds` past the epoch.
fn rtc_at(seconds: i64) -> (CmosRtc, Arc<AtomicI64>) {
    let clock = Arc::new(AtomicI64::new(seconds * NANOS));
    let now = Arc::clone(&clock);
    let rtc = CmosRtc::new(Box::new(move || now.load(Ordering::SeqCst)));
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
