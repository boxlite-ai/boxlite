//! Validation and Linux termios application for execution PTYs.

use super::exec_handle::{PtyConfig, PtyMode};
use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use nix::libc;
use std::os::fd::AsRawFd;

const MAX_TERMINAL_MODES: usize = 256;

impl TryFrom<&boxlite_shared::TtyConfig> for PtyConfig {
    type Error = BoxliteError;

    fn try_from(config: &boxlite_shared::TtyConfig) -> Result<Self, Self::Error> {
        if config.modes.len() > MAX_TERMINAL_MODES {
            return Err(BoxliteError::InvalidArgument(format!(
                "TTY has {} terminal modes; maximum is {MAX_TERMINAL_MODES}",
                config.modes.len()
            )));
        }

        let modes = config
            .modes
            .iter()
            .map(|mode| {
                let opcode = u8::try_from(mode.opcode).map_err(|_| {
                    BoxliteError::InvalidArgument(format!(
                        "TTY mode opcode {} exceeds the RFC 4254 byte range",
                        mode.opcode
                    ))
                })?;
                if is_control_character(opcode) && mode.value > u8::MAX as u32 {
                    return Err(BoxliteError::InvalidArgument(format!(
                        "TTY control-character mode {opcode} has value {} outside the byte range",
                        mode.value
                    )));
                }
                Ok(PtyMode {
                    opcode,
                    value: mode.value,
                })
            })
            .collect::<BoxliteResult<Vec<_>>>()?;

        Ok(Self {
            rows: dimension("rows", config.rows)?,
            cols: dimension("cols", config.cols)?,
            x_pixels: dimension("x_pixels", config.x_pixels)?,
            y_pixels: dimension("y_pixels", config.y_pixels)?,
            modes,
        })
    }
}

pub(crate) fn dimension(name: &str, value: u32) -> BoxliteResult<u16> {
    u16::try_from(value).map_err(|_| {
        BoxliteError::InvalidArgument(format!(
            "TTY {name} value {value} exceeds the kernel u16 limit"
        ))
    })
}

/// Apply RFC 4254 terminal modes to an already-open Linux PTY endpoint.
///
/// Setting attributes through either the slave (direct guest execution) or
/// the master (container console-socket execution) updates the shared PTY.
pub(crate) fn apply_modes(fd: &impl AsRawFd, modes: &[PtyMode]) -> BoxliteResult<()> {
    if modes.is_empty() {
        return Ok(());
    }

    let raw_fd = fd.as_raw_fd();
    let mut termios = read_termios(raw_fd)?;
    for mode in modes {
        apply_mode(&mut termios, mode)?;
    }
    write_termios(raw_fd, &termios)
}

fn read_termios(fd: libc::c_int) -> BoxliteResult<libc::termios> {
    let mut termios = std::mem::MaybeUninit::<libc::termios>::uninit();
    if unsafe { libc::tcgetattr(fd, termios.as_mut_ptr()) } == -1 {
        return Err(BoxliteError::Internal(format!(
            "Failed to read PTY terminal modes: {}",
            std::io::Error::last_os_error()
        )));
    }
    Ok(unsafe { termios.assume_init() })
}

fn write_termios(fd: libc::c_int, termios: &libc::termios) -> BoxliteResult<()> {
    if unsafe { libc::tcsetattr(fd, libc::TCSANOW, termios) } == -1 {
        return Err(BoxliteError::Internal(format!(
            "Failed to apply PTY terminal modes: {}",
            std::io::Error::last_os_error()
        )));
    }
    Ok(())
}

fn apply_mode(termios: &mut libc::termios, mode: &PtyMode) -> BoxliteResult<()> {
    let enabled = mode.value != 0;
    match mode.opcode {
        1 => set_control_character(termios, libc::VINTR, mode.value),
        2 => set_control_character(termios, libc::VQUIT, mode.value),
        3 => set_control_character(termios, libc::VERASE, mode.value),
        4 => set_control_character(termios, libc::VKILL, mode.value),
        5 => set_control_character(termios, libc::VEOF, mode.value),
        6 => set_control_character(termios, libc::VEOL, mode.value),
        7 => set_control_character(termios, libc::VEOL2, mode.value),
        8 => set_control_character(termios, libc::VSTART, mode.value),
        9 => set_control_character(termios, libc::VSTOP, mode.value),
        10 => set_control_character(termios, libc::VSUSP, mode.value),
        12 => set_control_character(termios, libc::VREPRINT, mode.value),
        13 => set_control_character(termios, libc::VWERASE, mode.value),
        14 => set_control_character(termios, libc::VLNEXT, mode.value),
        16 => set_control_character(termios, libc::VSWTC, mode.value),
        18 => set_control_character(termios, libc::VDISCARD, mode.value),

        30 => set_flag(&mut termios.c_iflag, libc::IGNPAR, enabled),
        31 => set_flag(&mut termios.c_iflag, libc::PARMRK, enabled),
        32 => set_flag(&mut termios.c_iflag, libc::INPCK, enabled),
        33 => set_flag(&mut termios.c_iflag, libc::ISTRIP, enabled),
        34 => set_flag(&mut termios.c_iflag, libc::INLCR, enabled),
        35 => set_flag(&mut termios.c_iflag, libc::IGNCR, enabled),
        36 => set_flag(&mut termios.c_iflag, libc::ICRNL, enabled),
        37 => set_flag(&mut termios.c_iflag, libc::IUCLC, enabled),
        38 => set_flag(&mut termios.c_iflag, libc::IXON, enabled),
        39 => set_flag(&mut termios.c_iflag, libc::IXANY, enabled),
        40 => set_flag(&mut termios.c_iflag, libc::IXOFF, enabled),
        41 => set_flag(&mut termios.c_iflag, libc::IMAXBEL, enabled),
        42 => set_flag(&mut termios.c_iflag, libc::IUTF8, enabled),

        50 => set_flag(&mut termios.c_lflag, libc::ISIG, enabled),
        51 => set_flag(&mut termios.c_lflag, libc::ICANON, enabled),
        52 => set_flag(&mut termios.c_lflag, libc::XCASE, enabled),
        53 => set_flag(&mut termios.c_lflag, libc::ECHO, enabled),
        54 => set_flag(&mut termios.c_lflag, libc::ECHOE, enabled),
        55 => set_flag(&mut termios.c_lflag, libc::ECHOK, enabled),
        56 => set_flag(&mut termios.c_lflag, libc::ECHONL, enabled),
        57 => set_flag(&mut termios.c_lflag, libc::NOFLSH, enabled),
        58 => set_flag(&mut termios.c_lflag, libc::TOSTOP, enabled),
        59 => set_flag(&mut termios.c_lflag, libc::IEXTEN, enabled),
        60 => set_flag(&mut termios.c_lflag, libc::ECHOCTL, enabled),
        61 => set_flag(&mut termios.c_lflag, libc::ECHOKE, enabled),
        62 => set_flag(&mut termios.c_lflag, libc::PENDIN, enabled),

        70 => set_flag(&mut termios.c_oflag, libc::OPOST, enabled),
        71 => set_flag(&mut termios.c_oflag, libc::OLCUC, enabled),
        72 => set_flag(&mut termios.c_oflag, libc::ONLCR, enabled),
        73 => set_flag(&mut termios.c_oflag, libc::OCRNL, enabled),
        74 => set_flag(&mut termios.c_oflag, libc::ONOCR, enabled),
        75 => set_flag(&mut termios.c_oflag, libc::ONLRET, enabled),

        90 => set_character_size(termios, libc::CS7, enabled),
        91 => set_character_size(termios, libc::CS8, enabled),
        92 => set_flag(&mut termios.c_cflag, libc::PARENB, enabled),
        93 => set_flag(&mut termios.c_cflag, libc::PARODD, enabled),

        128 => set_speed(termios, mode.value, true)?,
        129 => set_speed(termios, mode.value, false)?,
        _ => {}
    }
    Ok(())
}

fn set_control_character(termios: &mut libc::termios, index: usize, value: u32) {
    termios.c_cc[index] = if value == u8::MAX as u32 {
        libc::_POSIX_VDISABLE
    } else {
        value as libc::cc_t
    };
}

fn set_flag(flags: &mut libc::tcflag_t, flag: libc::tcflag_t, enabled: bool) {
    if enabled {
        *flags |= flag;
    } else {
        *flags &= !flag;
    }
}

fn set_character_size(termios: &mut libc::termios, size: libc::tcflag_t, enabled: bool) {
    let current_size = termios.c_cflag & libc::CSIZE;
    if enabled {
        termios.c_cflag = (termios.c_cflag & !libc::CSIZE) | size;
    } else if current_size == size {
        termios.c_cflag &= !libc::CSIZE;
    }
}

fn set_speed(termios: &mut libc::termios, baud: u32, is_input: bool) -> BoxliteResult<()> {
    let Some(speed) = baud_rate(baud) else {
        // A PTY does not transmit over a physical line. Preserve its current
        // speed when a platform cannot represent the client's baud rate.
        return Ok(());
    };
    let result = if is_input {
        unsafe { libc::cfsetispeed(termios, speed) }
    } else {
        unsafe { libc::cfsetospeed(termios, speed) }
    };
    if result == -1 {
        return Err(BoxliteError::Internal(format!(
            "Failed to set PTY baud rate {baud}: {}",
            std::io::Error::last_os_error()
        )));
    }
    Ok(())
}

fn baud_rate(baud: u32) -> Option<libc::speed_t> {
    Some(match baud {
        0 => libc::B0,
        50 => libc::B50,
        75 => libc::B75,
        110 => libc::B110,
        134 => libc::B134,
        150 => libc::B150,
        200 => libc::B200,
        300 => libc::B300,
        600 => libc::B600,
        1_200 => libc::B1200,
        1_800 => libc::B1800,
        2_400 => libc::B2400,
        4_800 => libc::B4800,
        9_600 => libc::B9600,
        19_200 => libc::B19200,
        38_400 => libc::B38400,
        57_600 => libc::B57600,
        115_200 => libc::B115200,
        230_400 => libc::B230400,
        460_800 => libc::B460800,
        500_000 => libc::B500000,
        576_000 => libc::B576000,
        921_600 => libc::B921600,
        1_000_000 => libc::B1000000,
        1_152_000 => libc::B1152000,
        1_500_000 => libc::B1500000,
        2_000_000 => libc::B2000000,
        2_500_000 => libc::B2500000,
        3_000_000 => libc::B3000000,
        3_500_000 => libc::B3500000,
        4_000_000 => libc::B4000000,
        _ => return None,
    })
}

fn is_control_character(opcode: u8) -> bool {
    matches!(opcode, 1..=18)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nix::pty::{openpty, OpenptyResult};

    fn wire_tty(rows: u32, modes: Vec<boxlite_shared::TtyMode>) -> boxlite_shared::TtyConfig {
        boxlite_shared::TtyConfig {
            rows,
            cols: 80,
            x_pixels: 0,
            y_pixels: 0,
            modes,
        }
    }

    #[test]
    fn validates_wire_dimensions_and_terminal_modes_without_truncation() {
        let config = PtyConfig::try_from(&wire_tty(
            24,
            vec![boxlite_shared::TtyMode {
                opcode: 53,
                value: 0,
            }],
        ))
        .unwrap();
        assert_eq!(config.rows, 24);
        assert_eq!(
            config.modes[0],
            PtyMode {
                opcode: 53,
                value: 0
            }
        );

        let error = PtyConfig::try_from(&wire_tty(u16::MAX as u32 + 1, Vec::new())).unwrap_err();
        assert!(error.to_string().contains("kernel u16 limit"));

        let error = PtyConfig::try_from(&wire_tty(
            24,
            vec![boxlite_shared::TtyMode {
                opcode: 1,
                value: u8::MAX as u32 + 1,
            }],
        ))
        .unwrap_err();
        assert!(error.to_string().contains("outside the byte range"));

        let error = PtyConfig::try_from(&wire_tty(
            24,
            vec![boxlite_shared::TtyMode {
                opcode: u8::MAX as u32 + 1,
                value: 0,
            }],
        ))
        .unwrap_err();
        assert!(error.to_string().contains("opcode"));
    }

    #[test]
    fn applies_modes_through_both_pty_endpoints() {
        let OpenptyResult { master, slave } = openpty(None, None).unwrap();
        apply_modes(
            &slave,
            &[
                PtyMode {
                    opcode: 1,
                    value: 3,
                },
                PtyMode {
                    opcode: 2,
                    value: u8::MAX as u32,
                },
                PtyMode {
                    opcode: 36,
                    value: 0,
                },
                PtyMode {
                    opcode: 53,
                    value: 0,
                },
                PtyMode {
                    opcode: 128,
                    value: 9_600,
                },
                PtyMode {
                    opcode: 129,
                    value: 9_600,
                },
            ],
        )
        .unwrap();

        let termios = read_termios(master.as_raw_fd()).unwrap();
        assert_eq!(termios.c_cc[libc::VINTR], 3);
        assert_eq!(termios.c_cc[libc::VQUIT], libc::_POSIX_VDISABLE);
        assert_eq!(termios.c_iflag & libc::ICRNL, 0);
        assert_eq!(termios.c_lflag & libc::ECHO, 0);
        assert_eq!(unsafe { libc::cfgetispeed(&termios) }, libc::B9600);
        assert_eq!(unsafe { libc::cfgetospeed(&termios) }, libc::B9600);

        apply_modes(
            &master,
            &[PtyMode {
                opcode: 53,
                value: 1,
            }],
        )
        .unwrap();
        let termios = read_termios(slave.as_raw_fd()).unwrap();
        assert_ne!(termios.c_lflag & libc::ECHO, 0);
    }
}
