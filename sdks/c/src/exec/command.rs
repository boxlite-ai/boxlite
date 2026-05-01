use std::os::raw::{c_char, c_int};

use boxlite::BoxliteError;

use crate::util::c_str_to_string;

/// C-compatible command descriptor with all BoxCommand options.
///
/// All string fields are nullable — NULL means "use default".
/// `timeout_secs` of 0.0 means no timeout.
#[repr(C)]
pub struct BoxliteCommand {
    /// Command to execute (required, must not be NULL).
    pub command: *const c_char,
    /// Array of argument strings. NULL = no args.
    pub args: *const *const c_char,
    /// Number of arguments in `args`.
    pub argc: c_int,
    /// Array of env var pairs: [key0, val0, key1, ...]. NULL = inherit env.
    pub env_pairs: *const *const c_char,
    /// Number of strings in `env_pairs`; odd trailing values are ignored.
    pub env_count: c_int,
    /// Working directory inside the container. NULL = container default.
    pub workdir: *const c_char,
    /// User spec (e.g., "nobody", "1000:1000"). NULL = container default.
    pub user: *const c_char,
    /// Timeout in seconds. 0.0 = no timeout.
    pub timeout_secs: f64,
    /// Enable TTY mode for interactive programs.
    pub tty: c_int,
}

pub(super) unsafe fn parse_boxlite_command(
    cmd: &BoxliteCommand,
) -> Result<boxlite::BoxCommand, BoxliteError> {
    unsafe {
        let cmd_str = c_str_to_string(cmd.command)?;
        let mut box_cmd = boxlite::BoxCommand::new(cmd_str)
            .args(crate::util::parse_c_string_array(cmd.args, cmd.argc));

        let env_pairs = crate::util::parse_c_string_array(cmd.env_pairs, cmd.env_count);
        for pair in env_pairs.chunks(2) {
            if let [key, value] = pair {
                box_cmd = box_cmd.env(key.clone(), value.clone());
            }
        }

        if !cmd.workdir.is_null() {
            box_cmd = box_cmd.working_dir(c_str_to_string(cmd.workdir)?);
        }

        if !cmd.user.is_null() {
            box_cmd = box_cmd.user(c_str_to_string(cmd.user)?);
        }

        if cmd.timeout_secs > 0.0 {
            box_cmd = box_cmd.timeout(std::time::Duration::from_secs_f64(cmd.timeout_secs));
        }

        if cmd.tty != 0 {
            box_cmd = box_cmd.tty(true);
        }

        Ok(box_cmd)
    }
}
