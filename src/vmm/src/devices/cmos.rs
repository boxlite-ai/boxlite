// Copyright 2026 BoxLite Contributors
// SPDX-License-Identifier: Apache-2.0

//! The CMOS real-time clock (RTC) of a PC, at ports 0x70 and 0x71.
//!
//! The guest writes a register number to port 0x70, then reads or writes that
//! register through port 0x71. Linux registers it as `rtc0`, but takes its
//! boot time from kvm-clock: the guest kernel leaves `RTC_HCTOSYS` off, so
//! this clock never overrides it.
//!
//! The time is an injected [`Clock`] plus an offset, so a time the guest
//! writes stays set and keeps running. While the guest sets the time, the
//! clock stops and the registers hold what it wrote; when the clock restarts,
//! it starts half a second into the written second, because Linux writes the
//! time half a second early (`set_offset_nsec` in `rtc-cmos.c`). The century
//! is register 0x32, which stopping the clock sets to the current century.
//!
//! Alarm matches latch AF in register C. IRQF and GSI 8 follow AF and AIE.
//! Further matches coalesce until the guest reads C.
//! Linux emulates update interrupts with that alarm, and `hwclock` waits
//! on them. Not modelled: 12-hour mode, day and month alarms, and
//! periodic and update-ended interrupts.
//!
//! A snapshot is four operations with the signatures of `VirtioDevice`.
//! `quiesce` stops the alarm thread and `save_state` reads the state without
//! changing it: the selected register, the CMOS bytes with AF and IRQF in
//! byte 0x0C, the offset and the pending alarm, as a Postcard payload in a
//! `DeviceSnapshot` of format 1, version 1. `restore_state` checks a
//! snapshot and replaces the state whole, leaving the device paused.
//! `resume` raises IRQ 8 once for an alarm that fell due meanwhile, then
//! restarts the thread. Nothing calls the four operations yet.

use std::{
    sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError},
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use crate::{
    bus::{BusDevice, UNCLAIMED_READ},
    error::Error,
    events::{Event, EventSender},
    irq::IrqLine,
};

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
use crate::virtio::{DeviceError, DeviceSnapshot, RestoreContext, SnapshotError};
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
use serde::{Deserialize, Serialize};

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
// The alarm registers, each matched against the time register before it.
const SECONDS_ALARM: usize = 0x01;
const MINUTES_ALARM: usize = 0x03;
const HOURS_ALARM: usize = 0x05;
/// An alarm byte at or above this matches any value ("don't care").
const ALARM_ANY: u8 = 0xc0;
/// Status B: an alarm match raises IRQ 8.
const ALARM_INTERRUPT_ENABLE: u8 = 0x20;
/// Status C: an enabled interrupt is pending, here always the alarm.
const INTERRUPT_REQUEST: u8 = 0x80;
/// Status C: the time matched the alarm.
const ALARM_FLAG: u8 = 0x20;

/// The `DeviceSnapshot` format of the RTC state, and its only version.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const SNAPSHOT_FORMAT: u32 = 1;
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const SNAPSHOT_VERSION: u32 = 1;

const NANOS_PER_SECOND: i64 = 1_000_000_000;
const SECONDS_PER_DAY: i64 = 86_400;
/// Resample an armed alarm within one RTC tick after the host clock jumps.
const ALARM_RECHECK: Duration = Duration::from_secs(1);
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
    /// The alarm the worker raises, and register C's flags.
    alarm: Arc<Alarm>,
    /// The thread that raises the alarm; `drop` stops and joins it.
    worker: Option<JoinHandle<()>>,
}

impl CmosRtc {
    /// An RTC on `clock` that drives `irq`. The worker starts on the first
    /// alarm configuration write, after the chipset has been built.
    pub(crate) fn new(clock: Clock, irq: IrqLine, event_sender: EventSender) -> Self {
        let mut registers = [0; 128];
        registers[STATUS_A] = STATUS_A_AT_POWER_ON;
        registers[STATUS_B] = HOURS_24_MODE;
        registers[STATUS_D] = TIME_VALID;
        let armed = Armed::after(
            AlarmFields {
                second: Some(0),
                minute: Some(0),
                hour: Some(0),
            },
            clock().div_euclid(NANOS_PER_SECOND),
        );
        Self {
            selected: 0,
            registers,
            alarm: Arc::new(Alarm {
                state: Mutex::new(AlarmState {
                    clock,
                    offset_from_clock: 0,
                    irq,
                    event_sender,
                    armed: Some(armed),
                    matched: false,
                    aie: false,
                    stopping: false,
                    paused: false,
                }),
                changed: Condvar::new(),
            }),
            worker: None,
        }
    }

    /// Starts the alarm thread once; a failed start ends the VM.
    fn start_worker(&mut self) {
        if self.worker.is_some() {
            return;
        }
        let alarm = Arc::clone(&self.alarm);
        match thread::Builder::new()
            .name("cmos-alarm".into())
            .spawn(move || alarm.run())
        {
            Ok(worker) => self.worker = Some(worker),
            Err(source) => self.alarm.state().fail(Error::SpawnRtcAlarm(source)),
        }
    }

    /// Whether the time advances: set mode is off and the divider is not in reset.
    fn clock_running(&self) -> bool {
        self.registers[STATUS_B] & SET_MODE == 0
            && self.registers[STATUS_A] & DIVIDER_BITS <= DIVIDER_32KHZ
    }

    fn read_register(&mut self, register: usize) -> u8 {
        match register {
            _ if TIME_REGISTERS.contains(&register) && self.clock_running() => {
                self.time_register(register, self.alarm.state().guest_time_nanos())
            }
            STATUS_A => self.registers[STATUS_A] & !UPDATE_IN_PROGRESS,
            // Reading register C clears it.
            STATUS_C => {
                let mut state = self.alarm.state();
                let now = state.guest_time_nanos();
                state.settle_match(now);
                let flags = state.flags();
                if state.matched {
                    state.matched = false;
                    state.armed = self.next_alarm(now);
                    state.update_irq();
                }
                drop(state);
                self.alarm.changed.notify_one();
                flags
            }
            _ => self.registers[register],
        }
    }

    fn write_register(&mut self, register: usize, value: u8) {
        if matches!(register, STATUS_C | STATUS_D) {
            return;
        }
        if register > STATUS_B && register != CENTURY {
            self.registers[register] = value;
            return;
        }

        let mut state = self.alarm.state();
        let host_now = (state.clock)();
        let now = host_now.saturating_add(state.offset_from_clock);
        state.settle_match(now);

        let was_running = self.clock_running();
        let previous = self.registers[register];
        match register {
            STATUS_A => self.registers[register] = value & !UPDATE_IN_PROGRESS,
            STATUS_B => self.registers[register] = value | HOURS_24_MODE,
            _ => {}
        }
        let running = self.clock_running();
        let writing_time = TIME_REGISTERS.contains(&register);
        if was_running && (writing_time || !running) {
            for field in TIME_REGISTERS {
                self.registers[field] = self.time_register(field, now);
            }
        }
        if !matches!(register, STATUS_A | STATUS_B) {
            self.registers[register] = value;
        }

        if running && (writing_time || !was_running) {
            let fraction = if was_running {
                now.rem_euclid(NANOS_PER_SECOND)
            } else {
                // Linux writes half a second before the new time is due.
                NANOS_PER_SECOND / 2
            };
            if let Some(nanos) = self.registers_time_nanos(fraction) {
                state.offset_from_clock = nanos.saturating_sub(host_now);
            }
        }
        let reschedule = match register {
            STATUS_A => was_running != running,
            STATUS_B => was_running != running || (previous ^ value) & BINARY_MODE != 0,
            _ => true,
        };
        if reschedule {
            state.armed = self.next_alarm(host_now.saturating_add(state.offset_from_clock));
        }
        state.aie = self.registers[STATUS_B] & ALARM_INTERRUPT_ENABLE != 0;
        state.update_irq();
        let start_worker = state.armed.is_some() && !state.stopping && !state.paused;
        drop(state);
        if start_worker {
            self.start_worker();
        }
        self.alarm.changed.notify_one();
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
        let century = field(CENTURY).filter(|century| *century <= 99)?;
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

    /// The next matching guest second while the clock runs and the alarm
    /// fields are valid.
    fn next_alarm(&self, now: i64) -> Option<Armed> {
        if !self.clock_running() {
            return None;
        }
        let field = |register: usize, limit: i64| match self.registers[register] {
            raw if raw >= ALARM_ANY => Some(None),
            raw => self.decode(raw).filter(|value| *value < limit).map(Some),
        };
        let fields = AlarmFields {
            second: field(SECONDS_ALARM, 60)?,
            minute: field(MINUTES_ALARM, 60)?,
            hour: field(HOURS_ALARM, 24)?,
        };
        Some(Armed::after(fields, now.div_euclid(NANOS_PER_SECOND)))
    }

    /// Stops the alarm thread and waits for it, so nothing changes IRQ 8
    /// until `resume`. Repeated calls are harmless.
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    #[cfg_attr(not(test), expect(dead_code, reason = "No snapshot caller yet."))]
    pub(crate) fn quiesce(&mut self) -> Result<(), DeviceError> {
        self.alarm.state().paused = true;
        self.alarm.changed.notify_one();
        if let Some(worker) = self.worker.take()
            && worker.join().is_err()
        {
            return Err(DeviceError::Fatal("joining the CMOS RTC alarm thread"));
        }
        Ok(())
    }

    /// The state for a snapshot, valid only after `quiesce`. Reading it
    /// changes nothing: register C's flags go into byte 0x0C of a copy.
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    #[cfg_attr(not(test), expect(dead_code, reason = "No snapshot caller yet."))]
    pub(crate) fn save_state(&self) -> Result<DeviceSnapshot, SnapshotError> {
        let state = self.alarm.state();
        let mut registers = self.registers;
        registers[STATUS_C] = state.flags();
        let snapshot = CmosRtcState {
            // The select port keeps seven bits, and restore checks the rest.
            selected: u8::try_from(self.selected).expect("the selected register is below 128"),
            registers: registers.to_vec(),
            offset_from_clock: state.offset_from_clock,
            armed: state.armed,
        };
        Ok(DeviceSnapshot {
            format: SNAPSHOT_FORMAT,
            version: SNAPSHOT_VERSION,
            // The fields are integers, options and a byte vector, and the
            // buffer grows, so nothing can fail.
            payload: postcard::to_allocvec(&snapshot)
                .expect("postcard cannot fail into a growable buffer"),
        })
    }

    /// Checks `snapshot`, then replaces the state with it only if every check
    /// passes. The device then stays paused until `resume`: no thread runs
    /// and IRQ 8 does not change. Meant for a device nothing else uses.
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    #[cfg_attr(not(test), expect(dead_code, reason = "No snapshot caller yet."))]
    pub(crate) fn restore_state(
        &mut self,
        snapshot: DeviceSnapshot,
        _ctx: RestoreContext,
    ) -> Result<(), DeviceError> {
        if snapshot.format != SNAPSHOT_FORMAT {
            return Err(DeviceError::Fatal("checking the CMOS RTC snapshot format"));
        }
        if snapshot.version != SNAPSHOT_VERSION {
            return Err(DeviceError::Fatal("checking the CMOS RTC snapshot version"));
        }
        let (state, trailing) = postcard::take_from_bytes::<CmosRtcState>(&snapshot.payload)
            .map_err(|error| {
                tracing::debug!(?error, "the CMOS RTC snapshot does not decode");
                DeviceError::Fatal("decoding the CMOS RTC snapshot")
            })?;
        // Bytes after the state mean it is not the state this version wrote.
        if !trailing.is_empty() {
            return Err(DeviceError::Fatal("decoding the CMOS RTC snapshot"));
        }
        let out_of_range = |field: Option<i64>, limit: i64| {
            field.is_some_and(|field| !(0..limit).contains(&field))
        };
        // Register 128 or more would panic at the next data-port access. The
        // alarm ranges are ones `next_alarm` never produces.
        if state.selected >= 128
            || state.armed.is_some_and(|armed| {
                out_of_range(armed.fields.hour, 24)
                    || out_of_range(armed.fields.minute, 60)
                    || out_of_range(armed.fields.second, 60)
            })
        {
            return Err(DeviceError::Fatal("checking the CMOS RTC snapshot fields"));
        }

        let CmosRtcState {
            selected,
            registers,
            offset_from_clock,
            armed,
        } = state;
        // The bank is saved as a byte sequence, so its length needs a check.
        let mut registers = <[u8; 128]>::try_from(registers)
            .map_err(|_| DeviceError::Fatal("checking the CMOS RTC snapshot fields"))?;
        // AF is the alarm thread's `matched`; IRQF follows from AIE.
        let matched = registers[STATUS_C] & ALARM_FLAG != 0;
        let aie = registers[STATUS_B] & ALARM_INTERRUPT_ENABLE != 0;
        registers[STATUS_C] = 0;
        self.selected = usize::from(selected);
        self.registers = registers;
        let mut state = self.alarm.state();
        state.offset_from_clock = offset_from_clock;
        state.armed = armed;
        state.matched = matched;
        state.aie = aie;
        state.paused = true;
        Ok(())
    }

    /// Ends the pause. An alarm that fell due meanwhile latches AF and raises
    /// IRQ 8 once; an AF latched before is not raised again. Repeated calls
    /// are harmless. Fails when the device has stopped, and also when raising
    /// IRQ 8 or starting the thread fails, like every other device failure.
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    #[cfg_attr(not(test), expect(dead_code, reason = "No snapshot caller yet."))]
    pub(crate) fn resume(&mut self) -> Result<(), DeviceError> {
        let mut state = self.alarm.state();
        if state.stopping {
            return Err(DeviceError::Fatal("resuming the CMOS RTC"));
        }
        state.paused = false;
        let was_matched = state.matched;
        let now = state.guest_time_nanos();
        state.settle_match(now);
        if !was_matched && state.matched {
            state.update_irq();
        }
        let start_worker = state.armed.is_some() && !state.stopping;
        drop(state);
        if start_worker {
            self.start_worker();
        }
        self.alarm.changed.notify_one();
        // A failed line update or thread start stopped the device above.
        if self.alarm.state().stopping {
            return Err(DeviceError::Fatal("resuming the CMOS RTC"));
        }
        Ok(())
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

impl Drop for CmosRtc {
    fn drop(&mut self) {
        self.alarm.state().stopping = true;
        self.alarm.changed.notify_one();
        if let Some(worker) = self.worker.take()
            && worker.join().is_err()
        {
            tracing::warn!("the CMOS RTC alarm thread panicked");
        }
    }
}

/// The alarm's second, minute and hour; `None` matches any value.
#[derive(Clone, Copy, Debug)]
#[cfg_attr(test, derive(PartialEq))]
#[cfg_attr(
    all(target_os = "linux", target_arch = "x86_64"),
    derive(Serialize, Deserialize)
)]
struct AlarmFields {
    second: Option<i64>,
    minute: Option<i64>,
    hour: Option<i64>,
}

impl AlarmFields {
    /// Seconds from `second_of_day` to the next second the alarm matches,
    /// 1 to 86 400; an alarm that matches only `second_of_day` is a day away.
    fn seconds_to_next_match(self, second_of_day: i64) -> i64 {
        if let (Some(hour), Some(minute), Some(second)) = (self.hour, self.minute, self.second) {
            let ahead = hour * 3600 + minute * 60 + second - second_of_day;
            return if ahead > 0 {
                ahead
            } else {
                ahead + SECONDS_PER_DAY
            };
        }
        (1..SECONDS_PER_DAY)
            .find(|ahead| self.matches((second_of_day + ahead).rem_euclid(SECONDS_PER_DAY)))
            .unwrap_or(SECONDS_PER_DAY)
    }

    fn matches(self, second_of_day: i64) -> bool {
        let matches = |field: Option<i64>, value: i64| field.is_none_or(|field| field == value);
        matches(self.second, second_of_day % 60)
            && matches(self.minute, second_of_day / 60 % 60)
            && matches(self.hour, second_of_day / 3600)
    }
}

/// A pending occurrence in guest RTC seconds since the Unix epoch.
#[cfg_attr(test, derive(Debug, PartialEq))]
#[derive(Clone, Copy)]
#[cfg_attr(
    all(target_os = "linux", target_arch = "x86_64"),
    derive(Serialize, Deserialize)
)]
struct Armed {
    target_second: i64,
    observed_second: i64,
    fields: AlarmFields,
}

impl Armed {
    fn after(fields: AlarmFields, current_second: i64) -> Self {
        let ahead = fields.seconds_to_next_match(current_second.rem_euclid(SECONDS_PER_DAY));
        Self {
            target_second: current_second + ahead,
            observed_second: current_second,
            fields,
        }
    }
}

/// The state a snapshot carries: the selected register, the CMOS bytes with
/// AF and IRQF in byte 0x0C, the guest offset from the host clock, and the
/// pending alarm with its deadline.
#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
#[derive(Serialize, Deserialize)]
struct CmosRtcState {
    selected: u8,
    /// The 128 CMOS bytes. A `Vec`, because serde's derive stops at arrays of
    /// 32 elements.
    registers: Vec<u8>,
    offset_from_clock: i64,
    armed: Option<Armed>,
}

/// RTC time, alarm flags and the IRQ line share one lock so a port access can
/// settle an overdue match before acknowledging or reconfiguring it.
struct AlarmState {
    clock: Clock,
    offset_from_clock: i64,
    irq: IrqLine,
    event_sender: EventSender,
    armed: Option<Armed>,
    matched: bool,
    aie: bool,
    stopping: bool,
    /// Set between `quiesce` and `resume`: the alarm thread stays stopped,
    /// and register writes do not start it.
    paused: bool,
}

impl AlarmState {
    fn guest_time_nanos(&self) -> i64 {
        (self.clock)().saturating_add(self.offset_from_clock)
    }

    fn settle_match(&mut self, now: i64) {
        if self.matched {
            return;
        }
        if let Some(armed) = &mut self.armed {
            let second = now.div_euclid(NANOS_PER_SECOND);
            if second < armed.observed_second {
                *armed = Armed::after(armed.fields, second);
            }
            armed.observed_second = second;
            self.matched = second >= armed.target_second;
        }
    }

    fn flags(&self) -> u8 {
        if !self.matched {
            0
        } else if self.aie {
            ALARM_FLAG | INTERRUPT_REQUEST
        } else {
            ALARM_FLAG
        }
    }

    fn update_irq(&mut self) {
        if !self.stopping
            && let Err(error) = self.irq.set_level(self.matched && self.aie)
        {
            self.fail(error);
        }
    }

    fn fail(&mut self, error: Error) {
        self.stopping = true;
        self.event_sender.send(Event::DeviceFailed(error));
    }
}

struct Alarm {
    state: Mutex<AlarmState>,
    changed: Condvar,
}

impl Alarm {
    fn state(&self) -> MutexGuard<'_, AlarmState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn run(&self) {
        let mut state = self.state();
        while !state.stopping && !state.paused {
            if state.armed.is_none() || state.matched {
                // Further matches coalesce while AF is pending.
                state = self
                    .changed
                    .wait(state)
                    .unwrap_or_else(PoisonError::into_inner);
                continue;
            }

            let now = state.guest_time_nanos();
            state.settle_match(now);
            if state.matched {
                state.update_irq();
                continue;
            }

            let armed = state.armed.as_ref().expect("alarm is armed");
            let seconds = armed.target_second - now.div_euclid(NANOS_PER_SECOND);
            let remaining = Duration::from_secs(seconds as u64)
                - Duration::from_nanos(now.rem_euclid(NANOS_PER_SECOND) as u64);
            state = self
                .changed
                .wait_timeout(state, remaining.min(ALARM_RECHECK))
                .unwrap_or_else(PoisonError::into_inner)
                .0;
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
