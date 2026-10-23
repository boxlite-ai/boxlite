// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The CMOS real-time clock (RTC) of a PC, at ports 0x70 and 0x71.
//!
//! The guest writes a register number to port 0x70, then reads or writes that
//! register through port 0x71. Linux reads the date and time from it once at
//! boot to set its system clock.
//!
//! The time is an injected [`Clock`] plus an offset, so a time the guest
//! writes stays set and keeps running. While the guest sets the time, the
//! clock stops and the registers hold what it wrote; when the clock restarts,
//! it starts half a second into the written second, because Linux writes the
//! time half a second early (`set_offset_nsec` in `rtc-cmos.c`).
//!
//! Not modelled: 12-hour mode, and IRQ 8, so alarm, update and periodic
//! interrupts never fire.

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

// The registers the guest selects at port 0x70: the time, then the four
// status registers.
const SECONDS: usize = 0x00;
const MINUTES: usize = 0x02;
const HOURS: usize = 0x04;
const DAY_OF_WEEK: usize = 0x06;
const DAY_OF_MONTH: usize = 0x07;
const MONTH: usize = 0x08;
const YEAR: usize = 0x09;
const STATUS_A: usize = 0x0a;
const STATUS_B: usize = 0x0b;
const STATUS_C: usize = 0x0c;
const STATUS_D: usize = 0x0d;
/// The century byte PC firmware uses; Linux reads it only through ACPI.
const CENTURY: usize = 0x32;
const TIME_REGISTERS: [usize; 8] = [
    SECONDS,
    MINUTES,
    HOURS,
    DAY_OF_WEEK,
    DAY_OF_MONTH,
    MONTH,
    YEAR,
    CENTURY,
];

/// Status A: the time is updating, which this clock never reports.
const UPDATE_IN_PROGRESS: u8 = 0x80;
/// Status A: the divider bits. Any value above `DIVIDER_32KHZ` holds the
/// divider in reset, which stops the clock.
const DIVIDER_BITS: u8 = 0x70;
/// Status A: the divider counts a 32.768 kHz crystal, so the clock runs.
const DIVIDER_32KHZ: u8 = 0x20;
/// Status A at power-on: the 32.768 kHz divider and a 1024 Hz periodic rate.
const STATUS_A_AT_POWER_ON: u8 = 0x26;
/// Status B: set mode stops the clock so the guest can write the time.
const SET_MODE: u8 = 0x80;
/// Status B: the time registers hold plain numbers instead of BCD.
const BINARY_MODE: u8 = 0x04;
/// Status B: hours count 0 to 23, the only mode modelled.
const HOURS_24_MODE: u8 = 0x02;
/// Status D: the RAM and the time are valid.
const TIME_VALID: u8 = 0x80;

const NANOS_PER_SECOND: i64 = 1_000_000_000;
const SECONDS_PER_DAY: i64 = 86_400;
/// The Gregorian calendar repeats every 400 years, an era of this many days.
const DAYS_PER_ERA: i64 = 146_097;
/// The date helpers count years from March, so leap days fall at a year's
/// end; this many days separate 0000-03-01 from 1970-01-01.
const DAYS_FROM_0000_03_01_TO_1970: i64 = 719_468;

/// The CMOS RTC and its 128 bytes of CMOS RAM.
pub(crate) struct CmosRtc {
    /// The register the next data-port access selects.
    selected: usize,
    /// The status registers, NVRAM, and the time while the clock is stopped.
    registers: [u8; 128],
    /// Guest time minus the clock, in nanoseconds.
    offset_from_clock: i64,
    /// Whether the guest wrote the century byte, which then sets the century.
    century_written: bool,
    clock: Clock,
}

impl CmosRtc {
    pub(crate) fn new(clock: Clock) -> Self {
        let mut registers = [0; 128];
        registers[STATUS_A] = STATUS_A_AT_POWER_ON;
        registers[STATUS_B] = HOURS_24_MODE;
        registers[STATUS_D] = TIME_VALID;
        Self {
            selected: 0,
            registers,
            offset_from_clock: 0,
            century_written: false,
            clock,
        }
    }

    /// Whether the time advances: set mode is off and the divider is not in reset.
    fn clock_running(&self) -> bool {
        self.registers[STATUS_B] & SET_MODE == 0
            && self.registers[STATUS_A] & DIVIDER_BITS <= DIVIDER_32KHZ
    }

    fn guest_time_nanos(&self) -> i64 {
        (self.clock)().saturating_add(self.offset_from_clock)
    }

    fn read_register(&self, register: usize) -> u8 {
        match register {
            _ if TIME_REGISTERS.contains(&register) && self.clock_running() => {
                self.time_register(register, self.guest_time_nanos())
            }
            STATUS_A => self.registers[STATUS_A] & !UPDATE_IN_PROGRESS,
            STATUS_C => 0,
            _ => self.registers[register],
        }
    }

    fn write_register(&mut self, register: usize, value: u8) {
        let was_running = self.clock_running();
        match register {
            STATUS_A => self.registers[STATUS_A] = value & !UPDATE_IN_PROGRESS,
            STATUS_B => self.registers[STATUS_B] = value | HOURS_24_MODE,
            STATUS_C | STATUS_D => {}
            _ if TIME_REGISTERS.contains(&register) => {
                self.century_written |= register == CENTURY;
                if was_running {
                    // Change one field of the running time, and keep how far
                    // into its second the clock was.
                    let now = self.guest_time_nanos();
                    self.freeze_time(now);
                    self.registers[register] = value;
                    self.restart_from_registers(now.rem_euclid(NANOS_PER_SECOND));
                } else {
                    self.registers[register] = value;
                }
            }
            _ => self.registers[register] = value,
        }
        match (was_running, self.clock_running()) {
            (true, false) => self.freeze_time(self.guest_time_nanos()),
            // Linux writes the time half a second before that time is due,
            // whether it restarts the clock through set mode or the divider.
            (false, true) => self.restart_from_registers(NANOS_PER_SECOND / 2),
            _ => {}
        }
    }

    /// Writes the time at `nanos` into the time registers, which keep it
    /// until the clock restarts.
    fn freeze_time(&mut self, nanos: i64) {
        for register in TIME_REGISTERS {
            self.registers[register] = self.time_register(register, nanos);
        }
    }

    /// Runs the clock on from the time in the registers, `fraction_nanos`
    /// into its second. A time the registers do not express leaves the clock
    /// where it was.
    fn restart_from_registers(&mut self, fraction_nanos: i64) {
        if let Some(nanos) = self.registers_time_nanos(fraction_nanos) {
            self.offset_from_clock = nanos.saturating_sub((self.clock)());
        }
    }

    /// The time in the registers, `fraction_nanos` into its second, or `None`
    /// when a field is out of range.
    fn registers_time_nanos(&self, fraction_nanos: i64) -> Option<i64> {
        let field = |register: usize| self.decode(self.registers[register]);
        let (second, minute, hour) = (field(SECONDS)?, field(MINUTES)?, field(HOURS)?);
        let (day, month, year) = (field(DAY_OF_MONTH)?, field(MONTH)?, field(YEAR)?);
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
        seconds
            .checked_mul(NANOS_PER_SECOND)?
            .checked_add(fraction_nanos)
    }

    /// Time register `register` at guest time `nanos`, in the format status B selects.
    fn time_register(&self, register: usize, nanos: i64) -> u8 {
        let seconds = nanos.div_euclid(NANOS_PER_SECOND);
        let days = seconds.div_euclid(SECONDS_PER_DAY);
        let second_of_day = seconds.rem_euclid(SECONDS_PER_DAY);
        let (year, month, day) = civil_from_days(days);
        let value = match register {
            SECONDS => second_of_day % 60,
            MINUTES => second_of_day / 60 % 60,
            HOURS => second_of_day / 3600,
            // 1970-01-01 was a Thursday, and Sunday is 1.
            DAY_OF_WEEK => (days + 4).rem_euclid(7) + 1,
            DAY_OF_MONTH => day,
            MONTH => month,
            YEAR => year.rem_euclid(100),
            _ => year.div_euclid(100).rem_euclid(100),
        };
        self.encode(value as u8)
    }

    fn in_binary_mode(&self) -> bool {
        self.registers[STATUS_B] & BINARY_MODE != 0
    }

    fn encode(&self, value: u8) -> u8 {
        if self.in_binary_mode() {
            value
        } else {
            ((value / 10) << 4) | (value % 10)
        }
    }

    /// A time register value, or `None` for a byte that is not BCD in BCD mode.
    fn decode(&self, raw: u8) -> Option<i64> {
        if self.in_binary_mode() {
            return Some(raw.into());
        }
        let (tens, ones) = (raw >> 4, raw & 0x0f);
        (tens <= 9 && ones <= 9).then(|| i64::from(tens * 10 + ones))
    }
}

impl BusDevice for CmosRtc {
    fn read(&mut self, offset: u64, data: &mut [u8]) {
        match (offset, data) {
            (1, [value]) => *value = self.read_register(self.selected),
            // The select port is write-only, and registers take byte accesses.
            (_, data) => data.fill(UNCLAIMED_READ),
        }
    }

    fn write(&mut self, offset: u64, data: &[u8]) {
        match (offset, data) {
            // Bit 7 masks NMI on a PC; there is no NMI source to mask here.
            (0, [value]) => self.selected = usize::from(value & 0x7f),
            (1, [value]) => self.write_register(self.selected, *value),
            _ => {}
        }
    }
}

/// The proleptic Gregorian date `days` after 1970-01-01, as Howard Hinnant's
/// `civil_from_days` computes it.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days_since_0000_03_01 = days + DAYS_FROM_0000_03_01_TO_1970;
    let era = days_since_0000_03_01.div_euclid(DAYS_PER_ERA);
    let day_of_era = days_since_0000_03_01.rem_euclid(DAYS_PER_ERA);
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
    era * DAYS_PER_ERA + day_of_era - DAYS_FROM_0000_03_01_TO_1970
}

#[cfg(test)]
#[path = "../../tests/cmos/mod.rs"]
mod tests;
