// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The MC146818 CMOS RTC behind ports 0x70 (index) and 0x71 (data).
//!
//! Linux reads it once at boot through `RTC_HCTOSYS`; the boot wall clock
//! itself comes from kvmclock. The time is an injected clock plus an offset
//! that keeps any time the guest sets. As in QEMU, the time registers freeze
//! while the SET bit or a divider reset holds them. A released clock resumes
//! half a second into the written second, which is what Linux expects of
//! this RTC (`set_offset_nsec` in `rtc-cmos.c`); QEMU does that only when the
//! divider restarts and otherwise keeps the old phase. Only 24-hour mode is
//! modelled, and there is no IRQ 8, so alarm, update and periodic interrupts
//! never fire.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::bus::{BusDevice, UNCLAIMED_READ};

/// The clock the RTC follows, in nanoseconds since the Unix epoch.
pub(crate) type Clock = Box<dyn Fn() -> i64 + Send>;

/// The host wall clock, in nanoseconds since the Unix epoch.
pub(crate) fn host_clock() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(after) => i64::try_from(after.as_nanos()).unwrap_or(i64::MAX),
        Err(before) => i64::try_from(before.duration().as_nanos()).map_or(i64::MIN, |ns| -ns),
    }
}

const SECONDS: usize = 0x00;
const MINUTES: usize = 0x02;
const HOURS: usize = 0x04;
const WEEKDAY: usize = 0x06;
const DAY: usize = 0x07;
const MONTH: usize = 0x08;
const YEAR: usize = 0x09;
const STATUS_A: usize = 0x0a;
const STATUS_B: usize = 0x0b;
const STATUS_C: usize = 0x0c;
const STATUS_D: usize = 0x0d;
/// The century byte PC firmware uses; Linux reads it only through ACPI.
const CENTURY: usize = 0x32;
const TIME_REGISTERS: [usize; 8] = [SECONDS, MINUTES, HOURS, WEEKDAY, DAY, MONTH, YEAR, CENTURY];

/// Register A: update in progress, which this model never reports.
const A_UIP: u8 = 0x80;
/// Register A: the divider bits; a value above 0x20 holds the divider in reset.
const A_DIVIDER: u8 = 0x70;
/// Register A at power-on: a 32.768 kHz time base and a 1024 Hz periodic rate.
const A_DEFAULT: u8 = 0x26;
/// Register B: SET stops the clock so the guest can write the time.
const B_SET: u8 = 0x80;
/// Register B: binary instead of BCD time registers.
const B_BINARY: u8 = 0x04;
/// Register B: 24-hour mode, the only mode modelled.
const B_24_HOUR: u8 = 0x02;
/// Register D: the RAM and the time are valid.
const D_VALID: u8 = 0x80;

const NANOS_PER_SECOND: i64 = 1_000_000_000;
const SECONDS_PER_DAY: i64 = 86_400;

/// The MC146818 RTC and its 128 bytes of CMOS RAM.
pub(crate) struct CmosRtc {
    /// The register the next data-port access selects.
    index: usize,
    /// Status registers, NVRAM, and the time latched while the clock is stopped.
    regs: [u8; 128],
    /// Guest time minus the clock, in nanoseconds.
    offset: i64,
    /// Whether the guest wrote the century byte, which then sets the century.
    century_written: bool,
    clock: Clock,
}

impl CmosRtc {
    pub(crate) fn new(clock: Clock) -> Self {
        let mut regs = [0; 128];
        regs[STATUS_A] = A_DEFAULT;
        regs[STATUS_B] = B_24_HOUR;
        regs[STATUS_D] = D_VALID;
        Self {
            index: 0,
            regs,
            offset: 0,
            century_written: false,
            clock,
        }
    }

    /// Whether the time advances: SET is clear and the divider is not in reset.
    fn running(&self) -> bool {
        self.regs[STATUS_B] & B_SET == 0 && self.regs[STATUS_A] & A_DIVIDER <= 0x20
    }

    fn guest_now(&self) -> i64 {
        (self.clock)().saturating_add(self.offset)
    }

    fn read_register(&self, index: usize) -> u8 {
        match index {
            _ if TIME_REGISTERS.contains(&index) && self.running() => {
                self.time_register(index, self.guest_now())
            }
            STATUS_A => self.regs[STATUS_A] & !A_UIP,
            STATUS_C => 0,
            _ => self.regs[index],
        }
    }

    fn write_register(&mut self, index: usize, value: u8) {
        let was_running = self.running();
        match index {
            STATUS_A => self.regs[STATUS_A] = value & !A_UIP,
            STATUS_B => self.regs[STATUS_B] = value | B_24_HOUR,
            STATUS_C | STATUS_D => {}
            _ if TIME_REGISTERS.contains(&index) => {
                self.century_written |= index == CENTURY;
                if was_running {
                    // A running clock takes the write at once and keeps its
                    // place within the current second.
                    let now = self.guest_now();
                    self.latch(now);
                    self.regs[index] = value;
                    self.commit(now.rem_euclid(NANOS_PER_SECOND));
                } else {
                    self.regs[index] = value;
                }
            }
            _ => self.regs[index] = value,
        }
        match (was_running, self.running()) {
            (true, false) => self.latch(self.guest_now()),
            // Linux writes the time half a second early for the first update
            // after a divider restart; its AMD path releases only SET, and
            // the same half second keeps that write on time too.
            (false, true) => self.commit(NANOS_PER_SECOND / 2),
            _ => {}
        }
    }

    /// Copies the time at `nanos` into the time registers.
    fn latch(&mut self, nanos: i64) {
        for index in TIME_REGISTERS {
            self.regs[index] = self.time_register(index, nanos);
        }
    }

    /// Makes the latched time current, `fraction` nanoseconds into its second.
    /// A time the registers do not express leaves the offset unchanged.
    fn commit(&mut self, fraction: i64) {
        if let Some(nanos) = self.latched_nanos(fraction) {
            self.offset = nanos.saturating_sub((self.clock)());
        }
    }

    fn latched_nanos(&self, fraction: i64) -> Option<i64> {
        let field = |index: usize| self.decode(self.regs[index]);
        let (second, minute, hour) = (field(SECONDS)?, field(MINUTES)?, field(HOURS)?);
        let (day, month, year) = (field(DAY)?, field(MONTH)?, field(YEAR)?);
        if second > 59
            || minute > 59
            || hour > 23
            || !(1..=31).contains(&day)
            || !(1..=12).contains(&month)
            || year > 99
        {
            return None;
        }
        let century = if self.century_written {
            field(CENTURY).filter(|century| *century <= 99)?
        } else if year < 70 {
            20
        } else {
            19
        };
        let days = days_from_civil(century * 100 + year, month, day);
        let seconds = days * SECONDS_PER_DAY + hour * 3600 + minute * 60 + second;
        seconds.checked_mul(NANOS_PER_SECOND)?.checked_add(fraction)
    }

    /// Time register `index` at guest time `nanos`, encoded as register B says.
    fn time_register(&self, index: usize, nanos: i64) -> u8 {
        let seconds = nanos.div_euclid(NANOS_PER_SECOND);
        let days = seconds.div_euclid(SECONDS_PER_DAY);
        let of_day = seconds.rem_euclid(SECONDS_PER_DAY);
        let (year, month, day) = civil_from_days(days);
        let value = match index {
            SECONDS => of_day % 60,
            MINUTES => of_day / 60 % 60,
            HOURS => of_day / 3600,
            // 1970-01-01 was a Thursday, and Sunday is 1.
            WEEKDAY => (days + 4).rem_euclid(7) + 1,
            DAY => day,
            MONTH => month,
            YEAR => year.rem_euclid(100),
            _ => year.div_euclid(100).rem_euclid(100),
        };
        self.encode(value as u8)
    }

    fn binary(&self) -> bool {
        self.regs[STATUS_B] & B_BINARY != 0
    }

    fn encode(&self, value: u8) -> u8 {
        if self.binary() {
            value
        } else {
            ((value / 10) << 4) | (value % 10)
        }
    }

    /// A time register value, or `None` for a byte that is not BCD in BCD mode.
    fn decode(&self, raw: u8) -> Option<i64> {
        if self.binary() {
            return Some(raw.into());
        }
        let (tens, ones) = (raw >> 4, raw & 0x0f);
        (tens <= 9 && ones <= 9).then(|| i64::from(tens * 10 + ones))
    }
}

impl BusDevice for CmosRtc {
    fn read(&mut self, offset: u64, data: &mut [u8]) {
        match (offset, data) {
            (1, [value]) => *value = self.read_register(self.index),
            // The index port is write-only, and registers take byte accesses.
            (_, data) => data.fill(UNCLAIMED_READ),
        }
    }

    fn write(&mut self, offset: u64, data: &[u8]) {
        match (offset, data) {
            // Bit 7 masks NMI on a PC; there is no NMI source to mask here.
            (0, [value]) => self.index = usize::from(value & 0x7f),
            (1, [value]) => self.write_register(self.index, *value),
            _ => {}
        }
    }
}

/// The proleptic Gregorian date `days` after 1970-01-01, as Howard Hinnant's
/// `civil_from_days` computes it.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_from_march = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_from_march + 2) / 5 + 1;
    let month = if month_from_march < 10 {
        month_from_march + 3
    } else {
        month_from_march - 9
    };
    (era * 400 + year_of_era + i64::from(month <= 2), month, day)
}

/// Days from 1970-01-01 to a proleptic Gregorian date, the inverse of
/// [`civil_from_days`]; days past the end of a month run into the next.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = year.div_euclid(400);
    let year_of_era = year.rem_euclid(400);
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
#[path = "../../tests/cmos/mod.rs"]
mod tests;
