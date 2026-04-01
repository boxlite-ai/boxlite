//! Utility functions shared across commands

/// Convert boxlite exit code to shell exit code.
///
/// Boxlite encodes signal termination as negative values (e.g., -9 for SIGKILL).
/// Shell convention uses 128 + signal_number for signal termination.
///
/// # Examples
///
/// ```
/// # use boxlite_cli::utils::to_shell_exit_code;
/// assert_eq!(to_shell_exit_code(0), 0);      // Normal success
/// assert_eq!(to_shell_exit_code(1), 1);      // Normal failure
/// assert_eq!(to_shell_exit_code(-9), 137);   // SIGKILL: 128 + 9
/// assert_eq!(to_shell_exit_code(-15), 143);  // SIGTERM: 128 + 15
/// ```
pub fn to_shell_exit_code(boxlite_code: i32) -> i32 {
    match boxlite_code {
        code if code < 0 => 128 + code.abs(),
        code => code,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_to_shell_exit_code_success() {
        assert_eq!(to_shell_exit_code(0), 0);
    }

    #[test]
    fn test_to_shell_exit_code_normal_failure() {
        assert_eq!(to_shell_exit_code(1), 1);
        assert_eq!(to_shell_exit_code(127), 127);
    }

    #[test]
    fn test_to_shell_exit_code_signal_termination() {
        // SIGKILL (9)
        assert_eq!(to_shell_exit_code(-9), 137);
        // SIGTERM (15)
        assert_eq!(to_shell_exit_code(-15), 143);
        // SIGINT (2)
        assert_eq!(to_shell_exit_code(-2), 130);
    }
}
