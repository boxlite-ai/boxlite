// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The MC146818 CMOS RTC behind ports `0x70` (index) and `0x71` (data).
//!
//! Linux's `rtc-cmos` driver probes this at boot to get the wall clock, and
//! `hwclock` reads it later. The protocol is two ports: write a register
//! number to `0x70` (bit 7 disables NMI generation, which we store and
//! ignore), then read or write that register through `0x71`.
//!
//! The time registers follow the PC layout: 0 seconds, 1 seconds alarm,
//! 2 minutes, 3 minutes alarm, 4 hours, 5 hours alarm, 6 day of week
//! (1 = Sunday), 7 day of month, 8 month, 9 year-of-century, with status
//! registers A–D at 0x0A–0x0D. Live registers (0, 2, 4, 6–9) are rendered
//! from an injected clock in the base (BCD or binary) and hour format
//! (12- or 24-hour) register B selects — the whole point of emulating this
//! part is that the guest's own `date` agrees with the host. Alarm
//! registers and everything from 0x0E up are plain NVRAM: writes stick, and
//! alarm reads mask off don't-care bits. While register B's SET bit is set,
//! live reads freeze to the stored bytes, as on real hardware.
//!
//! Times are UTC: BoxLite guests run UTC (there is no rtc-localtime knob in
//! the image), so no timezone is applied. Behavior cross-checked against
//! libkrun's and Firecracker's legacy devices (e12b9b3 / 68698ad).

use std::time::{SystemTime, UNIX_EPOCH};

use crate::bus::BusDevice;

/// Index register port; the device's window is this port plus the data port.
pub const PORT_INDEX: u16 = 0x70;
/// Data register port.
pub const PORT_DATA: u16 = 0x71;

// Register-B bits that change how the live registers render.
const B_DM: u8 = 0x04; // data mode: set = binary, clear = BCD
const B_24H: u8 = 0x02; // hour format: set = 24-hour, clear = 12-hour
const B_SET: u8 = 0x80; // freeze the clock: live reads return stored NVRAM

// Fixed status registers.
const REG_A: u8 = 0x26; // 32.768 kHz divider (bits 6:4), rate select 0110 (bits 3:0), UIP (bit 7) clear
// Register C (interrupt flags) reads 0x00: this device never schedules
// update-end or periodic interrupts, so no event is ever pending.
// Register D bit 7 (VRF) reads 1: the clock and NVRAM are valid, as they
// are on any PC whose CMOS battery is healthy. Linux's mc146818_get_time
// does not gate on VRF, but a 0 here would mean "battery dead, time
// unreliable", which is not what a fresh VM reports.
const REG_D: u8 = 0x80;

/// Seconds since the Unix epoch of a `SystemTime`, or 0 before 1970.
fn unix_seconds(now: SystemTime) -> u64 {
    now.duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// Broken-down UTC time from epoch seconds.
struct Civil {
    year: u64,
    month: u32,
    day: u32,
    hour: u32,
    min: u32,
    sec: u32,
}

/// Days-from-civil → (year, month, day) (Howard Hinnant's algorithm):
/// calendar arithmetic in ~15 lines instead of a crate dependency.
fn civil_from_days(days: u64) -> (u64, u32, u32) {
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z % 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 {
        mp as u32 + 3
    } else {
        mp as u32 - 9
    };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn civil(seconds: u64) -> Civil {
    let days = seconds / 86_400;
    let rem = seconds % 86_400;
    let (year, month, day) = civil_from_days(days);
    Civil {
        year,
        month,
        day,
        hour: (rem / 3600) as u32,
        min: (rem % 3600 / 60) as u32,
        sec: (rem % 60) as u32,
    }
}

/// Weekday as 0 = Sunday for the given epoch day (1970-01-01 was a
/// Thursday: day 0 → (0 + 4) % 7 → 4).
fn day_of_week(days_since_epoch: u64) -> u32 {
    ((days_since_epoch + 4) % 7) as u32
}

/// Renders a value in the base register B selects.
fn encode(value: u32, binary: bool) -> u8 {
    if binary {
        (value & 0xFF) as u8
    } else {
        ((((value % 100) / 10) << 4) | ((value % 100) % 10)) as u8
    }
}

/// Renders an hour in the base and 12/24-hour format register B selects.
/// 12-hour mode packs PM into bit 7 with 12-hour numbering (0 → 12 AM).
fn encode_hour(hour: u32, binary: bool, h24: bool) -> u8 {
    if h24 {
        encode(hour, binary)
    } else {
        let pm = (hour / 12) & 1 == 1;
        let mut value = hour % 12;
        if value == 0 {
            value = 12;
        }
        encode(value, binary) | u8::from(pm) << 7
    }
}

/// An emulated MC146818 with 128 bytes of NVRAM behind the index/data port
/// pair.
pub struct CmosRtc {
    /// Last value written to the index port; bit 7 is the NMI-disable flag,
    /// and bits 0–6 select a register.
    index: u8,
    ram: [u8; 128],
    clock: Box<dyn Fn() -> SystemTime + Send + Sync>,
}

impl CmosRtc {
    /// The first of the two ports the device occupies.
    pub const PORT_INDEX: u16 = PORT_INDEX;
    /// The second port.
    pub const PORT_DATA: u16 = PORT_DATA;

    /// Creates an RTC whose live registers come from `clock`. Tests pass a
    /// fixed clock; the machine builder will pass `SystemTime::now`.
    pub fn new(clock: impl Fn() -> SystemTime + Send + Sync + 'static) -> Self {
        Self {
            index: 0,
            ram: [0; 128],
            clock: Box::new(clock),
        }
    }

    /// Whether live registers render in plain binary (register B DM).
    fn binary(&self) -> bool {
        (self.ram[0x0B] & B_DM) != 0
    }

    /// Rendering for the live register `reg` at epoch time `now`, or `None`
    /// for anything else (those read as stored NVRAM).
    fn live(&self, reg: usize, now: u64) -> Option<u8> {
        if !matches!(reg, 0x00 | 0x02 | 0x04 | 0x06 | 0x07 | 0x08 | 0x09) {
            return None;
        }
        let c = civil(now);
        let binary = self.binary();
        let h24 = (self.ram[0x0B] & B_24H) != 0;
        Some(match reg {
            0x00 => encode(c.sec, binary),
            0x02 => encode(c.min, binary),
            0x04 => encode_hour(c.hour, binary, h24),
            0x06 => encode(day_of_week(now / 86_400) + 1, binary), // CMOS: 1 = Sunday
            0x07 => encode(c.day, binary),
            0x08 => encode(c.month, binary),
            _ => encode((c.year % 100) as u32, binary), // 0x09: year of century
        })
    }

    fn read_register(&self) -> u8 {
        let reg = (self.index & 0x7F) as usize;
        // Alarm bytes are NVRAM the guest programs; mask their don't-care
        // bits so a write can never set a pattern the part cannot match.
        let alarm_mask = match reg {
            0x01 | 0x03 => Some(0x7F),
            0x05 => Some(0x3F),
            _ => None,
        };
        if let Some(mask) = alarm_mask {
            return self.ram[reg] & mask;
        }
        // SET freezes the clock: live registers read back their stored bytes.
        if (self.ram[0x0B] & B_SET) != 0 {
            return self.ram[reg];
        }
        match reg {
            0x0A => REG_A,
            0x0C => 0,
            0x0D => REG_D,
            _ => self
                .live(reg, unix_seconds((self.clock)()))
                .unwrap_or(self.ram[reg]),
        }
    }
}

impl BusDevice for CmosRtc {
    /// The window is two ports: offset 0 is the index register, offset 1 the
    /// data register. A wide access walks them; offsets outside the window
    /// read 0 and never panic.
    fn read(&mut self, offset: u64, data: &mut [u8]) {
        for (i, byte) in data.iter_mut().enumerate() {
            *byte = match offset.saturating_add(i as u64) {
                0 => self.index,
                1 => self.read_register(),
                _ => 0,
            };
        }
    }

    fn write(&mut self, offset: u64, data: &[u8]) {
        for (i, byte) in data.iter().enumerate() {
            match offset.saturating_add(i as u64) {
                // Bit 7 disables NMI generation: stored for readback, no
                // side effect; data accesses use bits 0–6 only.
                0 => self.index = *byte,
                1 => {
                    let reg = (self.index & 0x7F) as usize;
                    self.ram[reg] = *byte;
                }
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// 2026-09-22T12:34:56Z (a Tuesday), the fixed wall clock under test.
    const NOW: u64 = 1_790_080_496;

    fn rtc_at(epoch: u64) -> CmosRtc {
        CmosRtc::new(move || UNIX_EPOCH + Duration::from_secs(epoch))
    }

    fn read_reg(rtc: &mut CmosRtc, reg: u8) -> u8 {
        let mut out = [0u8; 1];
        rtc.write(0, &[reg]);
        rtc.read(1, &mut out);
        out[0]
    }

    fn write_reg(rtc: &mut CmosRtc, reg: u8, value: u8) {
        rtc.write(0, &[reg]);
        rtc.write(1, &[value]);
    }

    #[test]
    fn bcd_mode_matches_the_pc_convention() {
        let mut rtc = rtc_at(NOW);
        write_reg(&mut rtc, 0x0B, B_24H); // BCD, 24-hour
        assert_eq!(read_reg(&mut rtc, 0x00), 0x56); // 56 s
        assert_eq!(read_reg(&mut rtc, 0x02), 0x34); // 34 m
        assert_eq!(read_reg(&mut rtc, 0x04), 0x12); // 12 h
        assert_eq!(read_reg(&mut rtc, 0x07), 0x22); // 22nd
        assert_eq!(read_reg(&mut rtc, 0x08), 0x09); // September
        assert_eq!(read_reg(&mut rtc, 0x09), 0x26); // year 2026
        assert_eq!(read_reg(&mut rtc, 0x06), 0x03); // weekday 3 (1 = Sunday)
    }

    #[test]
    fn binary_mode_follows_register_b() {
        let mut rtc = rtc_at(NOW);
        write_reg(&mut rtc, 0x0B, B_DM | B_24H);
        assert_eq!(read_reg(&mut rtc, 0x00), 56);
        assert_eq!(read_reg(&mut rtc, 0x02), 34);
        assert_eq!(read_reg(&mut rtc, 0x04), 12);
        assert_eq!(read_reg(&mut rtc, 0x07), 22);
    }

    #[test]
    fn twelve_hour_mode_packs_pm_into_bit7() {
        // 13:00:00 UTC → 1 PM.
        let mut pm = rtc_at(NOW + 3600 - 34 * 60 - 56);
        write_reg(&mut pm, 0x0B, 0x00); // BCD, 12-hour
        assert_eq!(read_reg(&mut pm, 0x04), 0x01 | 0x80);
        // Midnight reads as 12 AM.
        let mut midnight = rtc_at(NOW - 12 * 3600 - 34 * 60 - 56);
        write_reg(&mut midnight, 0x0B, 0x00);
        assert_eq!(read_reg(&mut midnight, 0x04), 0x12);
        // Noon is 12 PM.
        let mut noon = rtc_at(NOW);
        write_reg(&mut noon, 0x0B, 0x00);
        assert_eq!(read_reg(&mut noon, 0x04), 0x12 | 0x80);
    }

    #[test]
    fn set_bit_freezes_the_clock_to_stored_ram() {
        let mut rtc = rtc_at(NOW);
        write_reg(&mut rtc, 0x0B, B_SET);
        assert_eq!(read_reg(&mut rtc, 0x00), 0x00); // frozen at NVRAM zero
        write_reg(&mut rtc, 0x00, 0x42);
        assert_eq!(read_reg(&mut rtc, 0x00), 0x42);
        write_reg(&mut rtc, 0x0B, B_24H); // leave SET: live again
        assert_eq!(read_reg(&mut rtc, 0x00), 0x56);
    }

    #[test]
    fn alarm_registers_store_and_read_back_masked() {
        let mut rtc = rtc_at(NOW);
        write_reg(&mut rtc, 0x01, 0xFF);
        assert_eq!(read_reg(&mut rtc, 0x01), 0x7F);
        write_reg(&mut rtc, 0x03, 0xFF);
        assert_eq!(read_reg(&mut rtc, 0x03), 0x7F);
        write_reg(&mut rtc, 0x05, 0xFF);
        assert_eq!(read_reg(&mut rtc, 0x05), 0x3F);
        // Programming an alarm with no SET survives normal reads.
        write_reg(&mut rtc, 0x05, 0x12);
        assert_eq!(read_reg(&mut rtc, 0x05), 0x12);
    }

    #[test]
    fn status_registers_are_wired_constants() {
        let mut rtc = rtc_at(NOW);
        assert_eq!(read_reg(&mut rtc, 0x0A), REG_A);
        assert_eq!(read_reg(&mut rtc, 0x0C), 0x00);
        assert_eq!(read_reg(&mut rtc, 0x0D), REG_D);
        assert_eq!(read_reg(&mut rtc, 0x0D), 0x80); // VRF set: valid RAM and time
        // Writing them changes nothing observable.
        write_reg(&mut rtc, 0x0A, 0xFF);
        write_reg(&mut rtc, 0x0C, 0xFF);
        write_reg(&mut rtc, 0x0D, 0xFF);
        assert_eq!(read_reg(&mut rtc, 0x0A), REG_A);
        assert_eq!(read_reg(&mut rtc, 0x0C), 0x00);
        assert_eq!(read_reg(&mut rtc, 0x0D), REG_D);
    }

    #[test]
    fn nvram_round_trips_outside_the_live_range() {
        let mut rtc = rtc_at(NOW);
        write_reg(&mut rtc, 0x2A, 0x5A);
        assert_eq!(read_reg(&mut rtc, 0x2A), 0x5A);
        write_reg(&mut rtc, 0x32, 0x20); // the century byte
        assert_eq!(read_reg(&mut rtc, 0x32), 0x20);
        write_reg(&mut rtc, 0x7F, 0x11);
        assert_eq!(read_reg(&mut rtc, 0x7F), 0x11);
    }

    #[test]
    fn index_bit7_nmi_flag_does_not_alias_a_missing_register() {
        let mut rtc = rtc_at(NOW);
        write_reg(&mut rtc, 0x0B, B_24H);
        rtc.write(0, &[0x80 | 0x0B]); // NMI disabled, view of register B
        let mut out = [0u8; 1];
        rtc.read(1, &mut out);
        assert_eq!(out[0], B_24H);
        // A write through the NMI-flagged index still targets register B.
        rtc.write(1, &[0x00]);
        assert_eq!(read_reg(&mut rtc, 0x0B), 0x00);
        // And bit 7 itself reads back on the index port.
        rtc.write(0, &[0x80]);
        let mut out = [0u8; 1];
        rtc.read(0, &mut out);
        assert_eq!(out[0], 0x80);
    }

    #[test]
    fn leap_day_renders_correctly() {
        // 2024-02-29T00:00:00Z.
        let mut rtc = rtc_at(1_709_164_800);
        write_reg(&mut rtc, 0x0B, B_DM | B_24H);
        assert_eq!(read_reg(&mut rtc, 0x07), 29);
        assert_eq!(read_reg(&mut rtc, 0x08), 2);
        assert_eq!(read_reg(&mut rtc, 0x06), 5); // Thursday = 5 (1 = Sunday)
        assert_eq!(read_reg(&mut rtc, 0x09), 24);
    }

    #[test]
    fn wide_and_off_window_accesses_walk_ports_without_panic() {
        let mut rtc = rtc_at(NOW);
        write_reg(&mut rtc, 0x0B, B_24H); // BCD, 24-hour
        rtc.write(0, &[0x04]);
        let mut pair = [0u8; 2];
        rtc.read(0, &mut pair);
        assert_eq!(pair, [0x04, 0x12]); // index then hours (noon, 24h)
        // Offsets past the window read zero and writes are ignored.
        let mut junk = [0xFF; 4];
        rtc.read(2, &mut junk);
        assert_eq!(junk, [0; 4]);
        rtc.write(9, &[0x00]);
        rtc.write(u64::MAX, &[0; 8]);
    }
}
