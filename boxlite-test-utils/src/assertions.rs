//! Test assertion macros for boxlite.
//!
//! Provides expressive assertions that produce clear failure messages with
//! the failed expression, actual error, and source location.
//!
//! # Macros
//!
//! - [`assert_ok!`] — unwrap `Result::Ok`, show actual error on failure
//! - [`assert_err!`] — assert `Result::Err`, return the error
//! - [`assert_err_kind!`] — assert a specific `BoxliteError` variant
//! - [`assert_exec_ok!`] — assert `Result::Ok` AND `exit_code == 0`
//! - [`assert_err_contains!`] — assert error message contains substring

/// Unwrap a `Result::Ok`, panicking with a clear message on `Err`.
///
/// Returns the inner `Ok` value. On failure, shows the expression text,
/// the actual error, and the source location.
///
/// # Examples
///
/// ```ignore
/// let handle = assert_ok!(runtime.create(opts, None).await);
/// let handle = assert_ok!(runtime.create(opts, None).await, "creating box {}", name);
/// ```
#[macro_export]
macro_rules! assert_ok {
    ($expr:expr) => {
        match $expr {
            Ok(val) => val,
            Err(e) => {
                panic!(
                    "assert_ok! failed\n  expression: {}\n  error: {:?}\n  at: {}:{}",
                    stringify!($expr),
                    e,
                    file!(),
                    line!(),
                )
            }
        }
    };
    ($expr:expr, $($msg:tt)+) => {
        match $expr {
            Ok(val) => val,
            Err(e) => {
                panic!(
                    "assert_ok! failed: {}\n  expression: {}\n  error: {:?}\n  at: {}:{}",
                    format_args!($($msg)+),
                    stringify!($expr),
                    e,
                    file!(),
                    line!(),
                )
            }
        }
    };
}

/// Assert that a `Result` is `Err`, returning the error value.
///
/// Panics if the result is `Ok`, showing the unexpected success value.
///
/// # Examples
///
/// ```ignore
/// let err = assert_err!(runtime.remove("nonexistent", false).await);
/// assert!(err.to_string().contains("not found"));
/// ```
#[macro_export]
macro_rules! assert_err {
    ($expr:expr) => {
        match $expr {
            Err(e) => e,
            Ok(val) => {
                panic!(
                    "assert_err! failed — expected Err, got Ok\n  expression: {}\n  ok value: {:?}\n  at: {}:{}",
                    stringify!($expr),
                    val,
                    file!(),
                    line!(),
                )
            }
        }
    };
    ($expr:expr, $($msg:tt)+) => {
        match $expr {
            Err(e) => e,
            Ok(val) => {
                panic!(
                    "assert_err! failed: {} — expected Err, got Ok\n  expression: {}\n  ok value: {:?}\n  at: {}:{}",
                    format_args!($($msg)+),
                    stringify!($expr),
                    val,
                    file!(),
                    line!(),
                )
            }
        }
    };
}

/// Assert that a `Result` is `Err` matching a specific `BoxliteError` variant.
///
/// Panics with a clear message if the result is `Ok` or the wrong error variant.
///
/// # Examples
///
/// ```ignore
/// assert_err_kind!(
///     handle.exec(BoxCommand::new("echo").arg("world")).await,
///     BoxliteError::Stopped(_)
/// );
/// ```
#[macro_export]
macro_rules! assert_err_kind {
    ($expr:expr, $pattern:pat) => {
        match $expr {
            Err(ref e) if matches!(e, $pattern) => {}
            Err(e) => {
                panic!(
                    "assert_err_kind! failed — wrong error variant\n  expression: {}\n  expected: {}\n  actual: {:?}\n  at: {}:{}",
                    stringify!($expr),
                    stringify!($pattern),
                    e,
                    file!(),
                    line!(),
                )
            }
            Ok(val) => {
                panic!(
                    "assert_err_kind! failed — expected Err({}), got Ok\n  expression: {}\n  ok value: {:?}\n  at: {}:{}",
                    stringify!($pattern),
                    stringify!($expr),
                    val,
                    file!(),
                    line!(),
                )
            }
        }
    };
}

/// Assert that a `Result<ExecResult, _>` is `Ok` with `exit_code == 0`.
///
/// Returns the `ExecResult`. Panics if the result is `Err` or if the exit code
/// is non-zero.
///
/// # Examples
///
/// ```ignore
/// let result = assert_exec_ok!(execution.wait().await);
/// ```
#[macro_export]
macro_rules! assert_exec_ok {
    ($expr:expr) => {
        match $expr {
            Ok(result) => {
                if result.exit_code != 0 {
                    panic!(
                        "assert_exec_ok! failed — non-zero exit code\n  expression: {}\n  exit_code: {}\n  error_message: {:?}\n  at: {}:{}",
                        stringify!($expr),
                        result.exit_code,
                        result.error_message,
                        file!(),
                        line!(),
                    )
                }
                result
            }
            Err(e) => {
                panic!(
                    "assert_exec_ok! failed\n  expression: {}\n  error: {:?}\n  at: {}:{}",
                    stringify!($expr),
                    e,
                    file!(),
                    line!(),
                )
            }
        }
    };
}

/// Assert that an error's display message contains a substring.
///
/// Works with any type implementing `std::fmt::Display`.
///
/// # Examples
///
/// ```ignore
/// let err = assert_err!(result);
/// assert_err_contains!(err, "not found");
/// ```
#[macro_export]
macro_rules! assert_err_contains {
    ($err:expr, $substr:expr) => {
        {
            let err_msg = $err.to_string();
            let substr = $substr;
            if !err_msg.contains(substr) {
                panic!(
                    "assert_err_contains! failed\n  error: {}\n  expected to contain: {:?}\n  at: {}:{}",
                    err_msg,
                    substr,
                    file!(),
                    line!(),
                )
            }
        }
    };
}

#[cfg(test)]
mod tests {
    use std::fmt;

    // Simple error type for testing macros without depending on BoxliteError.
    #[derive(Debug)]
    #[allow(dead_code)]
    enum TestError {
        NotFound(String),
        InvalidState(String),
        Config(String),
    }

    impl fmt::Display for TestError {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            match self {
                TestError::NotFound(msg) => write!(f, "not found: {msg}"),
                TestError::InvalidState(msg) => write!(f, "invalid state: {msg}"),
                TestError::Config(msg) => write!(f, "config: {msg}"),
            }
        }
    }

    // Simple result type for exec assertions.
    #[derive(Debug)]
    struct MockExecResult {
        exit_code: i32,
        error_message: Option<String>,
    }

    #[test]
    fn assert_ok_returns_value_on_success() {
        let result: Result<i32, TestError> = Ok(42);
        let val = assert_ok!(result);
        assert_eq!(val, 42);
    }

    #[test]
    #[should_panic(expected = "assert_ok! failed")]
    fn assert_ok_panics_on_error() {
        let result: Result<i32, TestError> = Err(TestError::Config("bad".into()));
        let _ = assert_ok!(result);
    }

    #[test]
    #[should_panic(expected = "creating box")]
    fn assert_ok_with_context_message() {
        let result: Result<i32, TestError> = Err(TestError::Config("bad".into()));
        let _ = assert_ok!(result, "creating box {}", "test-box");
    }

    #[test]
    fn assert_err_returns_error_on_failure() {
        let result: Result<i32, TestError> = Err(TestError::NotFound("box-1".into()));
        let err = assert_err!(result);
        assert!(matches!(err, TestError::NotFound(_)));
    }

    #[test]
    #[should_panic(expected = "expected Err, got Ok")]
    fn assert_err_panics_on_success() {
        let result: Result<i32, TestError> = Ok(42);
        let _ = assert_err!(result);
    }

    #[test]
    fn assert_err_kind_matches_variant() {
        let result: Result<i32, TestError> = Err(TestError::NotFound("x".into()));
        assert_err_kind!(result, TestError::NotFound(_));
    }

    #[test]
    #[should_panic(expected = "wrong error variant")]
    fn assert_err_kind_panics_on_wrong_variant() {
        let result: Result<i32, TestError> = Err(TestError::Config("x".into()));
        assert_err_kind!(result, TestError::NotFound(_));
    }

    #[test]
    #[should_panic(expected = "expected Err")]
    fn assert_err_kind_panics_on_ok() {
        let result: Result<i32, TestError> = Ok(42);
        assert_err_kind!(result, TestError::NotFound(_));
    }

    #[test]
    fn assert_exec_ok_returns_result_on_zero_exit() {
        let result: Result<MockExecResult, TestError> = Ok(MockExecResult {
            exit_code: 0,
            error_message: None,
        });
        let r = assert_exec_ok!(result);
        assert_eq!(r.exit_code, 0);
    }

    #[test]
    #[should_panic(expected = "non-zero exit code")]
    fn assert_exec_ok_panics_on_nonzero_exit() {
        let result: Result<MockExecResult, TestError> = Ok(MockExecResult {
            exit_code: 1,
            error_message: Some("command failed".into()),
        });
        let _ = assert_exec_ok!(result);
    }

    #[test]
    #[should_panic(expected = "assert_exec_ok! failed")]
    fn assert_exec_ok_panics_on_error() {
        let result: Result<MockExecResult, TestError> = Err(TestError::Config("bad".into()));
        let _ = assert_exec_ok!(result);
    }

    #[test]
    fn assert_err_contains_matches_substring() {
        let err = TestError::NotFound("box-123".into());
        assert_err_contains!(err, "box-123");
    }

    #[test]
    #[should_panic(expected = "expected to contain")]
    fn assert_err_contains_panics_on_missing_substring() {
        let err = TestError::NotFound("box-123".into());
        assert_err_contains!(err, "nonexistent");
    }
}
