//! Context selection is exercised through the real CLI with isolated homes.

use assert_cmd::Command;
use predicates::str::contains;
use std::time::Duration;
use tempfile::TempDir;

fn cli(home: &TempDir) -> Command {
    let mut command = Command::new(assert_cmd::cargo::cargo_bin!("boxlite"));
    command
        .env("BOXLITE_HOME", home.path())
        .env_remove("BOXLITE_CONTEXT")
        .env_remove("BOXLITE_PROFILE")
        .env_remove("BOXLITE_REST_URL")
        .env_remove("BOXLITE_REST_PATH_PREFIX")
        .env_remove("BOXLITE_API_KEY")
        .timeout(Duration::from_secs(15));
    command
}

fn credentials(home: &TempDir) {
    std::fs::write(
        home.path().join("credentials.toml"),
        "[profiles.cloud]\nurl = 'https://cloud.example.test'\napi_key = 'cloud-secret'\n\
         [profiles.staging]\nurl = 'https://staging.example.test'\napi_key = 'staging-secret'\n",
    )
    .unwrap();
}

#[test]
fn saved_context_selects_credentials_without_repeating_a_flag() {
    let home = TempDir::new().unwrap();
    credentials(&home);
    std::fs::write(home.path().join("cli.toml"), "current_context = 'cloud'\n").unwrap();

    cli(&home)
        .args(["auth", "status"])
        .assert()
        .success()
        .stdout(contains("https://cloud.example.test"));
}

#[test]
fn use_persists_and_temporary_overrides_do_not_change_it() {
    let home = TempDir::new().unwrap();
    credentials(&home);
    let before = std::fs::read(home.path().join("credentials.toml")).unwrap();
    cli(&home)
        .args(["context", "use", "cloud"])
        .assert()
        .success()
        .stdout("cloud\n");
    cli(&home)
        .args(["context", "show"])
        .assert()
        .success()
        .stdout("cloud\n");
    for flag in ["--context", "--profile"] {
        cli(&home)
            .args([flag, "staging", "auth", "status"])
            .assert()
            .success()
            .stdout(contains("https://staging.example.test"));
        cli(&home)
            .args(["context", "show"])
            .assert()
            .success()
            .stdout("cloud\n");
    }
    assert_eq!(
        std::fs::read(home.path().join("credentials.toml")).unwrap(),
        before
    );
    cli(&home)
        .args(["context", "use", "default"])
        .assert()
        .success();
    cli(&home)
        .args(["context", "show"])
        .assert()
        .success()
        .stdout("default\n");
}

#[test]
fn context_precedence_matches_docker_including_host_overrides() {
    let home = TempDir::new().unwrap();
    credentials(&home);
    cli(&home)
        .args(["context", "use", "cloud"])
        .assert()
        .success();
    type SelectionCase<'a> = (&'a [&'a str], &'a [(&'a str, &'a str)], &'a str);
    let cases: &[SelectionCase<'_>] = &[
        (&[], &[], "cloud"),
        (&[], &[("BOXLITE_PROFILE", "staging")], "staging"),
        (
            &[],
            &[("BOXLITE_PROFILE", "cloud"), ("BOXLITE_CONTEXT", "staging")],
            "staging",
        ),
        (
            &[],
            &[("BOXLITE_CONTEXT", ""), ("BOXLITE_PROFILE", "staging")],
            "staging",
        ),
        (
            &[],
            &[
                ("BOXLITE_CONTEXT", ""),
                ("BOXLITE_PROFILE", ""),
                ("BOXLITE_REST_URL", ""),
            ],
            "cloud",
        ),
        (
            &[],
            &[
                ("BOXLITE_CONTEXT", "staging"),
                ("BOXLITE_REST_URL", "https://override.example.test"),
            ],
            "default",
        ),
        (
            &["--url", "https://override.example.test"],
            &[("BOXLITE_CONTEXT", "staging")],
            "default",
        ),
        (
            &["--context", "staging"],
            &[
                ("BOXLITE_REST_URL", "https://override.example.test"),
                ("BOXLITE_CONTEXT", "cloud"),
            ],
            "staging",
        ),
        (
            &["--profile", "staging"],
            &[("BOXLITE_CONTEXT", "cloud")],
            "staging",
        ),
        (
            &["--context", "default"],
            &[("BOXLITE_CONTEXT", "cloud")],
            "default",
        ),
    ];
    for (flags, environment, expected) in cases {
        cli(&home)
            .envs(environment.iter().copied())
            .args(*flags)
            .args(["context", "show"])
            .assert()
            .success()
            .stdout(format!("{expected}\n"));
    }
    cli(&home)
        .args(["context", "show"])
        .assert()
        .success()
        .stdout("cloud\n");
}

#[test]
fn use_warns_about_overrides_but_saves_its_positional_context() {
    let home = TempDir::new().unwrap();
    credentials(&home);
    cli(&home)
        .env("BOXLITE_CONTEXT", "staging")
        .args(["context", "use", "cloud"])
        .assert()
        .success()
        .stdout("cloud\n")
        .stderr(contains("BOXLITE_CONTEXT overrides"));
    cli(&home)
        .args(["context", "show"])
        .assert()
        .success()
        .stdout("cloud\n");
}

#[test]
fn listing_marks_effective_context_without_exposing_credentials() {
    let home = TempDir::new().unwrap();
    credentials(&home);
    cli(&home)
        .args(["context", "use", "cloud"])
        .assert()
        .success();
    let output = cli(&home)
        .env("BOXLITE_CONTEXT", "staging")
        .args(["context", "list"])
        .assert()
        .success();
    let stdout = String::from_utf8_lossy(&output.get_output().stdout);
    assert!(stdout.contains("staging *"));
    assert!(!stdout.contains("cloud *"));
    assert!(stdout.contains("embedded"));
    assert!(!stdout.contains("secret"));
    cli(&home)
        .args(["context", "ls", "--quiet"])
        .assert()
        .success()
        .stdout("cloud\ndefault\nstaging\n");
}

#[test]
fn unknown_context_and_logout_never_redirect_workloads() {
    let home = TempDir::new().unwrap();
    credentials(&home);
    cli(&home)
        .args(["context", "use", "cloud"])
        .assert()
        .success();
    let before = std::fs::read(home.path().join("cli.toml")).unwrap();
    cli(&home)
        .args(["context", "use", "missing"])
        .assert()
        .failure()
        .stderr(contains("context `missing` not found"));
    assert_eq!(std::fs::read(home.path().join("cli.toml")).unwrap(), before);
    cli(&home)
        .args(["--context", "missing", "context", "show"])
        .assert()
        .success()
        .stdout("missing\n");
    cli(&home)
        .args(["--context", "missing", "list"])
        .assert()
        .failure()
        .stderr(contains("context `missing` not found"));
    cli(&home)
        .args(["auth", "logout", "--yes"])
        .assert()
        .success();
    cli(&home)
        .args(["context", "show"])
        .assert()
        .success()
        .stdout("cloud\n");
    cli(&home)
        .args(["list"])
        .assert()
        .failure()
        .stderr(contains("context `cloud` not found"));
    cli(&home)
        .args(["auth", "status"])
        .assert()
        .success()
        .stdout(contains("Not logged in (context `cloud`)"));
    assert!(!home.path().join("boxes").exists());
}

#[test]
fn default_keeps_legacy_credentials_and_fresh_default_is_read_only() {
    let home = TempDir::new().unwrap();
    cli(&home)
        .args(["context", "use", "default"])
        .assert()
        .success();
    cli(&home)
        .args(["context", "show"])
        .assert()
        .success()
        .stdout("default\n");
    assert_eq!(std::fs::read_dir(home.path()).unwrap().count(), 0);
    std::fs::write(
        home.path().join("credentials.toml"),
        "[profiles.default]\nurl = 'https://legacy.example.test'\napi_key = 'secret'\n",
    )
    .unwrap();
    cli(&home)
        .args(["auth", "status"])
        .assert()
        .success()
        .stdout(contains("https://legacy.example.test"));
    cli(&home)
        .args(["context", "ls"])
        .assert()
        .success()
        .stdout(contains("https://legacy.example.test"));
}

#[test]
fn explicit_home_isolates_context_preferences_and_credentials() {
    let ambient = TempDir::new().unwrap();
    let explicit = TempDir::new().unwrap();
    credentials(&ambient);
    credentials(&explicit);
    cli(&ambient)
        .args(["context", "use", "cloud"])
        .assert()
        .success();
    cli(&ambient)
        .arg("--home")
        .arg(explicit.path())
        .args(["context", "use", "staging"])
        .assert()
        .success();
    cli(&ambient)
        .args(["context", "show"])
        .assert()
        .success()
        .stdout("cloud\n");
    cli(&ambient)
        .arg("--home")
        .arg(explicit.path())
        .args(["auth", "status"])
        .assert()
        .success()
        .stdout(contains("https://staging.example.test"));
}

#[test]
fn malformed_state_fails_but_help_completion_and_local_commands_are_independent() {
    let home = TempDir::new().unwrap();
    std::fs::write(home.path().join("cli.toml"), "current_context = [").unwrap();
    cli(&home)
        .args(["context", "show"])
        .assert()
        .failure()
        .stderr(contains("parsing context preferences"));
    cli(&home)
        .args(["list"])
        .assert()
        .failure()
        .stderr(contains("parsing context preferences"));
    for args in [
        &["--help"][..],
        &["context", "--help"],
        &["completion", "bash"],
        &["completion", "zsh"],
        &["completion", "fish"],
    ] {
        cli(&home)
            .env("BOXLITE_CONTEXT", "missing")
            .args(args)
            .assert()
            .success();
    }
    // The local command must reach its own validation, not context initialization.
    cli(&home)
        .env("BOXLITE_CONTEXT", "missing")
        .args(["--config", "/missing-boxlite-context-test.json", "images"])
        .assert()
        .failure()
        .stderr(contains("Configuration file not found"));
    let state = home.path().join("cli.toml");
    std::fs::remove_file(&state).unwrap();
    std::fs::create_dir(&state).unwrap();
    cli(&home)
        .args(["context", "show"])
        .assert()
        .failure()
        .stderr(contains("reading CLI context preferences"));
}

#[test]
fn selectors_are_nonempty_and_context_url_conflicts_are_usage_errors() {
    let home = TempDir::new().unwrap();
    for args in [
        &["--context", "", "list"][..],
        &["--profile", "", "list"],
        &[
            "--context",
            "cloud",
            "--url",
            "https://override.example.test",
            "list",
        ],
        &[
            "list",
            "--profile",
            "cloud",
            "--url",
            "https://override.example.test",
        ],
        &["--context", "cloud", "--profile", "staging", "list"],
    ] {
        cli(&home).args(args).assert().code(2);
    }
    cli(&home)
        .args(["context", "use", ""])
        .assert()
        .failure()
        .stderr(contains("context name must be nonempty"));
}

#[cfg(unix)]
#[test]
fn preference_updates_replace_atomically_and_remain_private() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let home = TempDir::new().unwrap();
    credentials(&home);
    std::fs::write(
        home.path().join("cli.toml"),
        "[future]\nsetting = 'preserved'\n",
    )
    .unwrap();
    cli(&home)
        .args(["context", "use", "cloud"])
        .assert()
        .success();
    let path = home.path().join("cli.toml");
    let before = std::fs::metadata(&path).unwrap();
    cli(&home)
        .args(["context", "use", "cloud"])
        .assert()
        .success();
    assert_eq!(
        std::fs::metadata(&path).unwrap().ino(),
        before.ino(),
        "unchanged selection should not rewrite preferences"
    );
    cli(&home)
        .args(["context", "use", "staging"])
        .assert()
        .success();
    let after = std::fs::metadata(&path).unwrap();
    assert_ne!(
        before.ino(),
        after.ino(),
        "switch must replace the file, not truncate it"
    );
    assert_eq!(after.permissions().mode() & 0o777, 0o600);
    let saved: toml::Value = toml::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
    assert_eq!(saved["future"]["setting"].as_str(), Some("preserved"));
    assert_eq!(
        std::fs::read_dir(home.path()).unwrap().count(),
        2,
        "temporary file must be cleaned up"
    );
}

#[cfg(unix)]
#[test]
fn invalid_utf8_selectors_fail_only_when_the_command_uses_them() {
    use std::ffi::OsString;
    use std::os::unix::ffi::OsStringExt;
    let home = TempDir::new().unwrap();
    for variable in ["BOXLITE_CONTEXT", "BOXLITE_PROFILE"] {
        let invalid = OsString::from_vec(vec![0xff]);
        cli(&home)
            .env(variable, &invalid)
            .args(["context", "show"])
            .assert()
            .code(2);
        cli(&home)
            .env(variable, &invalid)
            .args(["completion", "bash"])
            .assert()
            .success();
    }
}

struct Server {
    url: String,
    requests: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Server {
    async fn start() -> Self {
        use axum::{Json, Router, extract::Request, routing::any};
        let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let app = Router::new().fallback(any(move |request: Request| {
            let recorded = recorded.clone();
            async move {
                let path = request.uri().path().to_string();
                let bearer = request.headers().get("authorization").map(|v| v.to_str().unwrap()).unwrap_or("").to_string();
                recorded.lock().unwrap().push((path.clone(), bearer));
                if path.ends_with("/me") {
                    Json(serde_json::json!({"sub":"user", "principal_type":"user", "path_prefix":"tenant", "scopes":[]}))
                } else {
                    Json(serde_json::json!({"boxes":[]}))
                }
            }
        }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        Self {
            url,
            requests,
            task,
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn context_login_and_requests_use_the_selected_endpoint_bearer_and_tenant() {
    let home = TempDir::new().unwrap();
    let cloud = Server::start().await;
    let other = Server::start().await;
    cli(&home)
        .args([
            "--context",
            "cloud",
            "auth",
            "login",
            "--url",
            &cloud.url,
            "--api-key-stdin",
        ])
        .write_stdin("cloud-key\n")
        .assert()
        .success();
    cli(&home)
        .args(["context", "show"])
        .assert()
        .success()
        .stdout("default\n");
    cli(&home)
        .args(["context", "use", "cloud"])
        .assert()
        .success();
    // URL configures the saved context during login rather than selecting default.
    cli(&home)
        .args(["auth", "login", "--url", &cloud.url, "--api-key-stdin"])
        .write_stdin("cloud-key\n")
        .assert()
        .success();
    cloud.requests.lock().unwrap().clear();
    cli(&home).args(["list"]).assert().success();
    cli(&home)
        .env("BOXLITE_API_KEY", "override-key")
        .args(["list"])
        .assert()
        .success();
    cli(&home)
        .env("BOXLITE_REST_URL", &other.url)
        .args(["--context", "cloud", "list"])
        .assert()
        .success();
    cli(&home)
        .args(["list", "--path-prefix", "other-tenant"])
        .assert()
        .success();
    assert!(other.requests.lock().unwrap().is_empty());
    assert_eq!(
        *cloud.requests.lock().unwrap(),
        [
            (
                "/v1/tenant/boxes".to_string(),
                "Bearer cloud-key".to_string()
            ),
            (
                "/v1/tenant/boxes".to_string(),
                "Bearer override-key".to_string()
            ),
            (
                "/v1/tenant/boxes".to_string(),
                "Bearer cloud-key".to_string()
            ),
            (
                "/v1/other-tenant/boxes".to_string(),
                "Bearer cloud-key".to_string()
            ),
        ]
    );
    cli(&home)
        .env("BOXLITE_CONTEXT", "cloud")
        .env("BOXLITE_REST_URL", &other.url)
        .args(["list"])
        .assert()
        .success();
    assert_eq!(
        *other.requests.lock().unwrap(),
        [("/v1/boxes".to_string(), String::new())]
    );
    cli(&home)
        .args(["context", "show"])
        .assert()
        .success()
        .stdout("cloud\n");
}
