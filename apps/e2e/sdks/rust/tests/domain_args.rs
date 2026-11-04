//! The acceptance driver reports malformed invocations without panicking.
use std::process::Command;

#[test]
fn malformed_arguments_return_usage_errors() {
    for args in [
        vec![],
        vec!["bind"],
        vec!["bind", "demo.app.test"],
        vec!["unbind"],
        vec!["bind", "demo.app.test", "invalid"],
        vec!["list", "extra"],
        vec!["unknown"],
    ] {
        let result = Command::new(env!("CARGO_BIN_EXE_domain-rust"))
            .args(&args)
            .env("BOXLITE_E2E_URL", "http://127.0.0.1:9")
            .env("BOXLITE_E2E_API_KEY", "test-key")
            .env("BOXLITE_E2E_PREFIX", "default")
            .env("BOXLITE_E2E_BOX", "web")
            .output()
            .expect("start the acceptance driver");
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert!(!result.status.success(), "accepted {args:?}");
        assert_ne!(
            result.status.code(),
            Some(101),
            "panicked for {args:?}: {stderr}"
        );
        assert!(stderr.contains("usage:"), "no usage for {args:?}: {stderr}");
    }
}
