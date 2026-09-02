use assert_cmd::Command;
use predicates::prelude::PredicateBooleanExt;

const GLOBAL_OPTIONS: &[&str] = &[
    "--debug",
    "--home",
    "--registry",
    "--config",
    "--url",
    "--profile",
    "--path-prefix",
];

fn help_for(path: &[&str], help_flag: &str) -> String {
    let output = Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
        .args(path)
        .arg(help_flag)
        .assert()
        .success();
    std::str::from_utf8(&output.get_output().stdout)
        .unwrap()
        .to_owned()
}

fn declares_option(help: &str, option: &str) -> bool {
    help.lines().any(|line| {
        let declaration = line.trim_start();
        declaration.starts_with('-')
            && declaration
                .split_ascii_whitespace()
                .any(|token| token.trim_end_matches(',') == option)
    })
}

#[test]
fn command_help_only_advertises_meaningful_global_options() {
    let cases: &[(&[&str], &[&str])] = &[
        (&["run"], GLOBAL_OPTIONS),
        (
            &["exec"],
            &[
                "--debug",
                "--home",
                "--config",
                "--url",
                "--profile",
                "--path-prefix",
            ],
        ),
        (&["create"], GLOBAL_OPTIONS),
        (
            &["list"],
            &[
                "--debug",
                "--home",
                "--config",
                "--url",
                "--profile",
                "--path-prefix",
            ],
        ),
        (
            &["ls"],
            &[
                "--debug",
                "--home",
                "--config",
                "--url",
                "--profile",
                "--path-prefix",
            ],
        ),
        (
            &["ps"],
            &[
                "--debug",
                "--home",
                "--config",
                "--url",
                "--profile",
                "--path-prefix",
            ],
        ),
        (
            &["rm"],
            &[
                "--debug",
                "--home",
                "--config",
                "--url",
                "--profile",
                "--path-prefix",
            ],
        ),
        (
            &["start"],
            &[
                "--debug",
                "--home",
                "--config",
                "--url",
                "--profile",
                "--path-prefix",
            ],
        ),
        (
            &["stop"],
            &[
                "--debug",
                "--home",
                "--config",
                "--url",
                "--profile",
                "--path-prefix",
            ],
        ),
        (
            &["restart"],
            &[
                "--debug",
                "--home",
                "--config",
                "--url",
                "--profile",
                "--path-prefix",
            ],
        ),
        (&["pull"], &["--debug", "--home", "--registry", "--config"]),
        (&["images"], &["--debug", "--home", "--config"]),
        (
            &["inspect"],
            &[
                "--debug",
                "--home",
                "--config",
                "--url",
                "--profile",
                "--path-prefix",
            ],
        ),
        (
            &["cp"],
            &[
                "--debug",
                "--home",
                "--config",
                "--url",
                "--profile",
                "--path-prefix",
            ],
        ),
        (&["info"], &["--debug", "--home", "--config"]),
        (&["logs"], &["--debug", "--home", "--config"]),
        (
            &["stats"],
            &[
                "--debug",
                "--home",
                "--config",
                "--url",
                "--profile",
                "--path-prefix",
            ],
        ),
        (
            &["network"],
            &[
                "--debug",
                "--home",
                "--config",
                "--url",
                "--profile",
                "--path-prefix",
            ],
        ),
        (
            &["network", "tunnel"],
            &[
                "--debug",
                "--home",
                "--config",
                "--url",
                "--profile",
                "--path-prefix",
            ],
        ),
        (&["serve"], &["--debug", "--home", "--registry", "--config"]),
        (&["auth"], &["--debug", "--home", "--profile"]),
        (
            &["auth", "login"],
            &["--debug", "--home", "--url", "--profile"],
        ),
        (&["auth", "logout"], &["--debug", "--home", "--profile"]),
        (
            &["auth", "status"],
            &["--debug", "--home", "--url", "--profile"],
        ),
        (
            &["auth", "whoami"],
            &["--debug", "--home", "--url", "--profile"],
        ),
        (
            &["volume"],
            &["--debug", "--home", "--url", "--profile", "--path-prefix"],
        ),
        (
            &["volume", "create"],
            &["--debug", "--home", "--url", "--profile", "--path-prefix"],
        ),
        (
            &["volume", "ls"],
            &["--debug", "--home", "--url", "--profile", "--path-prefix"],
        ),
        (
            &["volume", "list"],
            &["--debug", "--home", "--url", "--profile", "--path-prefix"],
        ),
        (
            &["volume", "get"],
            &["--debug", "--home", "--url", "--profile", "--path-prefix"],
        ),
        (
            &["volume", "inspect"],
            &["--debug", "--home", "--url", "--profile", "--path-prefix"],
        ),
        (
            &["volume", "rm"],
            &["--debug", "--home", "--url", "--profile", "--path-prefix"],
        ),
        (
            &["volume", "delete"],
            &["--debug", "--home", "--url", "--profile", "--path-prefix"],
        ),
        (&["completion"], &[]),
    ];

    for help_flag in ["-h", "--help"] {
        for (path, visible) in cases {
            let help = help_for(path, help_flag);
            for option in GLOBAL_OPTIONS {
                assert_eq!(
                    declares_option(&help, option),
                    visible.contains(option),
                    "{option} visibility is wrong in `boxlite {} {help_flag}`:\n{help}",
                    path.join(" ")
                );
            }
        }
    }
}

#[test]
fn command_specific_help_has_no_noop_options() {
    let cases: &[(&[&str], &[&str])] = &[
        (&["exec"], &["--entrypoint"]),
        (&["create"], &["--detach", "--rm"]),
        (&["images"], &["--all"]),
        (&["cp"], &["--include-parent"]),
    ];

    for (path, absent) in cases {
        let help = help_for(path, "--help");
        for option in *absent {
            assert!(
                !declares_option(&help, option),
                "{option} is a no-op but appears in `boxlite {} --help`:\n{help}",
                path.join(" ")
            );
        }
    }

    let cp_help = help_for(&["cp"], "--help");
    assert!(
        declares_option(&cp_help, "--no-include-parent"),
        "{cp_help}"
    );
}

#[test]
fn serve_help_never_reveals_the_api_key_environment_value() {
    const SENTINEL: &str = "boxlite-help-must-mask-this-secret";

    Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
        .env("BOXLITE_SERVE_API_KEY", SENTINEL)
        .args(["serve", "--help"])
        .assert()
        .success()
        .stdout(predicates::str::contains(SENTINEL).not())
        .stderr(predicates::str::contains(SENTINEL).not());
}

#[test]
fn irrelevant_global_options_are_rejected_wherever_they_are_written() {
    for (args, diagnostic) in [
        (
            ["--url", "https://ignored.test", "completion", "bash"],
            "--url is not valid for `boxlite completion`",
        ),
        (
            ["completion", "bash", "--url", "https://ignored.test"],
            "unexpected argument '--url'",
        ),
    ] {
        Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
            .args(args)
            .assert()
            .failure()
            .stderr(predicates::str::contains(diagnostic));
    }
}

#[test]
fn irrelevant_global_environment_values_do_not_break_a_command() {
    Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
        .env("BOXLITE_HOME", "relative-but-unused")
        .args(["completion", "bash"])
        .assert()
        .success();
}

#[cfg(unix)]
#[test]
fn irrelevant_non_utf8_global_environment_values_do_not_break_a_command() {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
        .env(
            "BOXLITE_REST_URL",
            OsString::from_vec(vec![b'h', b't', b't', b'p', 0xff]),
        )
        .args(["completion", "bash"])
        .assert()
        .success();
}

#[cfg(unix)]
#[test]
fn auth_login_rejects_a_non_utf8_url_environment_value() {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;

    Command::new(assert_cmd::cargo::cargo_bin!("boxlite"))
        .env(
            "BOXLITE_REST_URL",
            OsString::from_vec(vec![b'h', b't', b't', b'p', 0xff]),
        )
        .args(["auth", "login", "--api-key-stdin"])
        .assert()
        .failure()
        .stderr(predicates::str::contains(
            "BOXLITE_REST_URL must contain valid UTF-8",
        ));
}
