//! Unit tests for GitHub Actions runner commands and warm VM reuse lifecycle.

use std::time::{Duration, Instant};

use clap::error::ErrorKind;

use boxlite::{BoxOptions, RootfsSpec};

use super::{
    ActionsRunnerCommand, RunnerLabelSpec, RunnerLifecycleState, RunnerSession, RunnerSize,
    StartRunnerArgs, normalize_github_repo_url,
};
use crate::cli::{Commands, try_parse_from};

fn parse(args: &[&str]) -> Result<ActionsRunnerCommand, clap::Error> {
    let cli = try_parse_from(["boxlite", "actions-runner"].iter().chain(args))?;
    let Commands::ActionsRunner(runner_args) = cli.command else {
        panic!("expected ActionsRunner command");
    };
    Ok(runner_args.command)
}

#[test]
fn start_runner_parses_minimal_arguments_with_defaults() {
    let cmd = parse(&[
        "start",
        "--url",
        "https://github.com/boxlite-ai/boxlite",
        "--token",
        "gh_token_test_123",
    ])
    .expect("parse minimal");

    let ActionsRunnerCommand::Start(start_args) = cmd else {
        panic!("expected Start command");
    };

    assert_eq!(start_args.url, "https://github.com/boxlite-ai/boxlite");
    assert_eq!(start_args.token, "gh_token_test_123");
    assert_eq!(start_args.idle_timeout, 300); // 5-minute warm window
    assert_eq!(start_args.image, "ubuntu:22.04");
    assert!(start_args.ephemeral);
    assert_eq!(start_args.labels, vec!["boxlite", "self-hosted", "linux"]);
}

#[test]
fn start_runner_accepts_overrides() {
    let cmd = parse(&[
        "start",
        "--url",
        "https://github.com/org/repo",
        "--token",
        "token456",
        "--name",
        "custom-runner",
        "--labels",
        "gpu,large,linux",
        "--image",
        "debian:12-slim",
        "--idle-timeout",
        "120",
    ])
    .expect("parse overrides");

    let ActionsRunnerCommand::Start(start_args) = cmd else {
        panic!("expected Start command");
    };

    assert_eq!(start_args.name.as_deref(), Some("custom-runner"));
    assert_eq!(start_args.labels, vec!["gpu", "large", "linux"]);
    assert_eq!(start_args.image, "debian:12-slim");
    assert_eq!(start_args.idle_timeout, 120);
}

#[test]
fn start_runner_requires_url() {
    let error = parse(&["start", "--token", "tok"]).unwrap_err();
    assert_eq!(error.kind(), ErrorKind::MissingRequiredArgument);
}

#[test]
fn start_runner_requires_token() {
    // Ensure ambient env doesn't satisfy token for this test
    unsafe { std::env::remove_var("GITHUB_RUNNER_TOKEN") };
    let error = parse(&["start", "--url", "https://github.com/org/repo"]).unwrap_err();
    assert_eq!(error.kind(), ErrorKind::MissingRequiredArgument);
}

#[test]
fn runner_session_validates_empty_inputs() {
    let args = StartRunnerArgs {
        url: "".to_string(),
        token: "tok".to_string(),
        name: None,
        labels: vec!["test".to_string()],
        image: "ubuntu:22.04".to_string(),
        idle_timeout: 300,
        ephemeral: true,
        work_dir: "/opt".into(),
    };
    assert!(RunnerSession::new(&args).is_err());

    let args_empty_token = StartRunnerArgs {
        url: "https://github.com/org/repo".to_string(),
        token: "   ".to_string(),
        name: None,
        labels: vec!["test".to_string()],
        image: "ubuntu:22.04".to_string(),
        idle_timeout: 300,
        ephemeral: true,
        work_dir: "/opt".into(),
    };
    assert!(RunnerSession::new(&args_empty_token).is_err());
}

#[test]
fn runner_session_warm_pool_lifecycle() {
    let args = StartRunnerArgs {
        url: "https://github.com/boxlite-ai/boxlite".to_string(),
        token: "test_token".to_string(),
        name: Some("test-warm-runner".to_string()),
        labels: vec!["boxlite".to_string()],
        image: "ubuntu:22.04".to_string(),
        idle_timeout: 300, // 5 minutes
        ephemeral: true,
        work_dir: "/opt".into(),
    };

    let mut session = RunnerSession::new(&args).expect("session init");
    assert_eq!(session.state, RunnerLifecycleState::Initializing);

    // Job 1 arrives and executes
    session.mark_job_started();
    assert_eq!(session.state, RunnerLifecycleState::RunningJob);
    assert!(session.idle_started_at.is_none());

    // Job 1 completes at t = 0
    let t0 = Instant::now();
    session.mark_job_finished(t0);
    assert_eq!(session.state, RunnerLifecycleState::IdleWarm);

    // At t + 60s (1 minute into the 5-minute window): warm VM is active
    let t1 = t0 + Duration::from_secs(60);
    assert!(session.is_warm_active(t1));
    assert!(!session.check_expiration(t1));

    // Warm reuse: Job 2 arrives before timeout expires!
    session.mark_job_started();
    assert_eq!(session.state, RunnerLifecycleState::RunningJob);

    // Job 2 finishes at t2
    let t2 = t1 + Duration::from_secs(45);
    session.mark_job_finished(t2);
    assert_eq!(session.state, RunnerLifecycleState::IdleWarm);

    // After 301 seconds of idle: warm window expires
    let t3 = t2 + Duration::from_secs(301);
    assert!(!session.is_warm_active(t3));
    assert!(session.check_expiration(t3));
    assert_eq!(session.state, RunnerLifecycleState::Expired);
}

#[test]
fn bootstrap_script_contains_required_directives() {
    let args = StartRunnerArgs {
        url: "https://github.com/boxlite-ai/boxlite".to_string(),
        token: "secret_runner_token".to_string(),
        name: Some("ci-runner-1".to_string()),
        labels: vec!["boxlite".to_string(), "warm-pool".to_string()],
        image: "ubuntu:22.04".to_string(),
        idle_timeout: 300,
        ephemeral: true,
        work_dir: "/opt".into(),
    };

    let session = RunnerSession::new(&args).unwrap();
    let script = session.generate_bootstrap_script("secret_runner_token");

    assert!(script.contains("https://github.com/boxlite-ai/boxlite"));
    assert!(script.contains("secret_runner_token"));
    assert!(script.contains("--name \"ci-runner-1\""));
    assert!(script.contains("--labels \"boxlite,warm-pool\""));
    assert!(script.contains("--ephemeral"));
    assert!(script.contains("./run.sh"));

    let config_pos = script
        .find("RUNNER_ALLOW_RUNASROOT=1 ./config.sh")
        .expect("bootstrap script should invoke config.sh");
    let run_pos = script
        .find("exec ./run.sh")
        .expect("bootstrap script should exec run.sh");
    assert!(config_pos < run_pos, "config.sh must run before run.sh");
}

#[test]
fn runner_size_parsing_and_hardware_specifications() {
    assert_eq!(RunnerSize::parse("small"), Some(RunnerSize::Small));
    assert_eq!(RunnerSize::parse("boat-small"), Some(RunnerSize::Small));
    assert_eq!(RunnerSize::parse("boxlite-small"), Some(RunnerSize::Small));
    assert_eq!(RunnerSize::Small.cpus(), 2);
    assert_eq!(RunnerSize::Small.memory_mib(), 4096);

    assert_eq!(RunnerSize::parse("default"), Some(RunnerSize::Default));
    assert_eq!(RunnerSize::parse("boxlite"), Some(RunnerSize::Default));
    assert_eq!(RunnerSize::Default.cpus(), 4);
    assert_eq!(RunnerSize::Default.memory_mib(), 8192);

    assert_eq!(RunnerSize::parse("large"), Some(RunnerSize::Large));
    assert_eq!(RunnerSize::parse("boat-large"), Some(RunnerSize::Large));
    assert_eq!(RunnerSize::parse("boxlite-large"), Some(RunnerSize::Large));
    assert_eq!(RunnerSize::Large.cpus(), 8);
    assert_eq!(RunnerSize::Large.memory_mib(), 16384);

    assert_eq!(RunnerSize::parse("xlarge"), Some(RunnerSize::XLarge));
    assert_eq!(
        RunnerSize::parse("boxlite-xlarge"),
        Some(RunnerSize::XLarge)
    );
    assert_eq!(RunnerSize::XLarge.cpus(), 16);
    assert_eq!(RunnerSize::XLarge.memory_mib(), 32768);

    assert_eq!(RunnerSize::parse("unknown-tier"), None);
}

#[test]
fn runner_label_spec_parsing_with_slash_options() {
    // 1. Standard default size
    let spec1 = RunnerLabelSpec::parse("boxlite,self-hosted,linux");
    assert_eq!(spec1.size, RunnerSize::Default);
    assert_eq!(spec1.from_image, None);
    assert!(!spec1.debug);
    assert!(spec1.kvm);

    // 2. Large size with custom image and debug enabled (Boat syntax)
    let spec2 = RunnerLabelSpec::parse("boxlite-large/from=custom-ci:v2/debug");
    assert_eq!(spec2.size, RunnerSize::Large);
    assert_eq!(spec2.from_image, Some("custom-ci:v2".to_string()));
    assert!(spec2.debug);
    assert!(spec2.kvm);

    // 3. Applying to BoxOptions
    let mut options = BoxOptions::default();
    spec2.apply_to_box_options(&mut options);
    assert_eq!(options.cpus, Some(8));
    assert_eq!(options.memory_mib, Some(16384));
    assert!(matches!(
        options.rootfs,
        RootfsSpec::Image(ref img) if img == "custom-ci:v2"
    ));
}

#[test]
fn normalize_github_repo_url_variations() {
    assert_eq!(
        normalize_github_repo_url("git@github.com:boxlite-ai/boxlite.git"),
        Some("https://github.com/boxlite-ai/boxlite".to_string())
    );
    assert_eq!(
        normalize_github_repo_url("ssh://git@github.com/acme/project.git"),
        Some("https://github.com/acme/project".to_string())
    );
    assert_eq!(
        normalize_github_repo_url("https://github.com/acme/project.git"),
        Some("https://github.com/acme/project".to_string())
    );
    assert_eq!(
        normalize_github_repo_url("https://github.com/acme/project"),
        Some("https://github.com/acme/project".to_string())
    );
    assert_eq!(normalize_github_repo_url("not-a-github-url"), None);
}

#[test]
fn connect_command_parses_arguments() {
    let cmd = parse(&[
        "connect",
        "--repo",
        "https://github.com/boxlite-ai/boxlite",
        "--token",
        "gh_token_test",
        "--size",
        "large",
        "--idle-timeout",
        "600",
        "--debug-on-failure",
    ])
    .expect("parse connect");

    let ActionsRunnerCommand::Connect(connect_args) = cmd else {
        panic!("expected Connect command");
    };

    assert_eq!(
        connect_args.repo.as_deref(),
        Some("https://github.com/boxlite-ai/boxlite")
    );
    assert_eq!(connect_args.token.as_deref(), Some("gh_token_test"));
    assert_eq!(connect_args.size, "large");
    assert_eq!(connect_args.idle_timeout, 600);
    assert!(connect_args.debug_on_failure);
}

#[test]
fn run_command_parses_arguments() {
    let cmd = parse(&[
        "run",
        "--push",
        ".",
        "--size",
        "xlarge",
        "--timeout",
        "1200",
        "--",
        "cargo",
        "test",
        "--all",
    ])
    .expect("parse run");

    let ActionsRunnerCommand::Run(run_args) = cmd else {
        panic!("expected Run command");
    };

    assert_eq!(run_args.command, vec!["cargo", "test", "--all"]);
    assert_eq!(run_args.push, std::path::PathBuf::from("."));
    assert_eq!(run_args.size, "xlarge");
    assert_eq!(run_args.timeout, 1200);
}
