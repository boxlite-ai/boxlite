//! `with-local-registry <command> [args...]`: run a command while the local
//! registry is up, with its address in `BOXLITE_TEST_REGISTRY`.
//!
//! Rust tests start the registry in-process through `test_registries()`. The
//! SDK integration suites run in other languages, so `make` wraps them in this
//! command instead. The registry lives exactly as long as the command.

use std::process::{Command, ExitCode};

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let Some(program) = args.next() else {
        eprintln!("usage: with-local-registry <command> [args...]");
        return ExitCode::from(2);
    };
    let registry = boxlite_test_utils::registry::local_registry();
    let status = Command::new(&program)
        .args(args)
        .env("BOXLITE_TEST_REGISTRY", registry.host())
        .status();
    match status {
        // A command a signal ended has no code; report it as a failure.
        Ok(status) => ExitCode::from(
            status
                .code()
                .and_then(|code| u8::try_from(code).ok())
                .unwrap_or(1),
        ),
        Err(error) => {
            eprintln!(
                "with-local-registry: cannot run {}: {error}",
                program.to_string_lossy()
            );
            ExitCode::from(127)
        }
    }
}
