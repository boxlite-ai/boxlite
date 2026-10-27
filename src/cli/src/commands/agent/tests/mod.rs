use super::*;
use crate::cli::{Commands, Shell, generate_completion, try_parse_from};
use clap::error::ErrorKind;
use serde_json::json;

fn parse(args: &[&str]) -> AgentCommand {
    let cli = try_parse_from(["boxlite", "agent"].iter().chain(args)).unwrap();
    let Commands::Agent(args) = cli.command else {
        panic!("expected agent command");
    };
    args.command
}

#[test]
fn agents_p0_create_groups_options_and_keeps_runtime_config_separate() {
    let cli = try_parse_from([
        "boxlite",
        "agent",
        "create",
        "box",
        "coder",
        "--cwd",
        "/workspace",
        "--agent-config",
        r#"{"model":"model-id"}"#,
        "--idempotency-key",
        "retry",
        "--config",
        "/missing-runtime.json",
    ])
    .unwrap();
    assert_eq!(cli.global.config.as_deref(), Some("/missing-runtime.json"));
    let Commands::Agent(AgentArgs {
        command:
            AgentCommand::Create {
                target,
                agent,
                options,
            },
    }) = cli.command
    else {
        panic!("expected create")
    };
    assert_eq!(target.target, "box");
    assert_eq!(agent, "coder");
    assert_eq!(options.cwd, Some(PathBuf::from("/workspace")));
    assert_eq!(options.agent_config, Some(json!({"model": "model-id"})));
    assert_eq!(options.control.idempotency_key.as_deref(), Some("retry"));
}

#[test]
fn agents_p0_send_defaults_to_queue_and_accepts_reject_and_json() {
    let AgentCommand::Session(SessionCommand::Send { options, .. }) =
        parse(&["session", "send", "box", "session", "hello"])
    else {
        panic!("expected send")
    };
    assert_eq!(options.mode, SendMode::Queue);
    assert_eq!(options.data, None);
    assert_eq!(options.control.idempotency_key, None);

    let AgentCommand::Session(SessionCommand::Send {
        target,
        text,
        options,
    }) = parse(&[
        "session",
        "send",
        "box",
        "session",
        "hello",
        "--mode",
        "reject",
        "--data",
        r#"{"value":1}"#,
        "--idempotency-key",
        "retry",
    ])
    else {
        panic!("expected send")
    };
    assert_eq!(target.sandbox.target, "box");
    assert_eq!(target.session, "session");
    assert_eq!(text, "hello");
    assert_eq!(options.mode, SendMode::Reject);
    assert_eq!(options.data, Some(json!({"value": 1})));
    assert_eq!(options.control.idempotency_key.as_deref(), Some("retry"));
}

#[test]
fn agents_p0_turn_options_preserve_target_timeout_cursor_and_retry_key() {
    let AgentCommand::Turn(TurnCommand::Wait { target, options }) = parse(&[
        "turn",
        "wait",
        "box",
        "session",
        "turn",
        "--timeout-seconds",
        "0",
    ]) else {
        panic!("expected wait")
    };
    assert_eq!(target.session.sandbox.target, "box");
    assert_eq!(target.session.session, "session");
    assert_eq!(target.turn, "turn");
    assert_eq!(options.timeout_seconds, Some(0));

    let AgentCommand::Turn(TurnCommand::Wait { options, .. }) =
        parse(&["turn", "wait", "box", "session", "turn"])
    else {
        panic!("expected wait")
    };
    assert_eq!(options.timeout_seconds, None);

    let AgentCommand::Turn(TurnCommand::Events { options, .. }) = parse(&[
        "turn", "events", "box", "session", "turn", "--after", "cursor",
    ]) else {
        panic!("expected events")
    };
    assert_eq!(options.after.as_deref(), Some("cursor"));

    let AgentCommand::Turn(TurnCommand::Steer { text, options, .. }) = parse(&[
        "turn",
        "steer",
        "box",
        "session",
        "turn",
        "use Rust",
        "--idempotency-key",
        "retry",
    ]) else {
        panic!("expected steer")
    };
    assert_eq!(text, "use Rust");
    assert_eq!(options.idempotency_key.as_deref(), Some("retry"));
}

#[test]
fn agents_p0_responses_keep_answer_and_permission_json_distinct() {
    for response in [
        r#"{"type":"answer","text":"yes"}"#,
        r#"{"type":"permission","approved":false}"#,
    ] {
        let AgentCommand::Session(SessionCommand::Respond {
            request,
            response: parsed,
            options,
            ..
        }) = parse(&[
            "session",
            "respond",
            "box",
            "session",
            "request",
            response,
            "--idempotency-key",
            "retry",
        ])
        else {
            panic!("expected respond")
        };
        assert_eq!(request, "request");
        assert_eq!(parsed, serde_json::from_str::<Value>(response).unwrap());
        assert_eq!(options.idempotency_key.as_deref(), Some("retry"));
    }
}

#[test]
fn agents_p0_parser_rejects_invalid_options_and_missing_targets() {
    let cases: &[(&[&str], ErrorKind)] = &[
        (&["create", "box"], ErrorKind::MissingRequiredArgument),
        (
            &["create", "box", "coder", "--agent-config", "not-json"],
            ErrorKind::ValueValidation,
        ),
        (
            &[
                "session",
                "send",
                "box",
                "session",
                "text",
                "--mode",
                "interrupt",
            ],
            ErrorKind::InvalidValue,
        ),
        (
            &["session", "send", "box", "session", "text", "--data", "{"],
            ErrorKind::ValueValidation,
        ),
        (
            &[
                "session", "respond", "box", "session", "request", "not-json",
            ],
            ErrorKind::ValueValidation,
        ),
        (
            &["turn", "steer", "box", "session", "turn"],
            ErrorKind::MissingRequiredArgument,
        ),
        (
            &[
                "turn",
                "wait",
                "box",
                "session",
                "turn",
                "--timeout-seconds=-1",
            ],
            ErrorKind::ValueValidation,
        ),
        (
            &[
                "turn",
                "wait",
                "box",
                "session",
                "turn",
                "--timeout-seconds=NaN",
            ],
            ErrorKind::ValueValidation,
        ),
        (
            &["get", "box", "session", "--registry", "irrelevant.test"],
            ErrorKind::UnknownArgument,
        ),
    ];
    for (args, expected) in cases {
        let error = try_parse_from(["boxlite", "agent"].iter().chain(args.iter())).unwrap_err();
        assert_eq!(&error.kind(), expected, "{args:?}");
    }
}

#[test]
fn agents_p0_help_and_completion_include_grouped_commands() {
    let mut command = crate::cli::command();
    command.build();
    let agent = command.find_subcommand_mut("agent").unwrap();
    let session = agent.find_subcommand_mut("session").unwrap();
    for name in [
        "close",
        "send",
        "get-turn",
        "events",
        "requests",
        "respond",
        "state",
        "config",
        "capabilities",
    ] {
        assert!(session.find_subcommand(name).is_some(), "{name}");
    }
    let help = session
        .find_subcommand_mut("send")
        .unwrap()
        .render_long_help()
        .to_string();
    for text in [
        "not implemented",
        "<BOX>",
        "<SESSION>",
        "<TEXT>",
        "--mode",
        "--data",
        "--idempotency-key",
    ] {
        assert!(help.contains(text), "{text}: {help}");
    }
    assert!(!help.contains("--registry"));
    for shell in [Shell::Bash, Shell::Zsh, Shell::Fish] {
        let mut output = Vec::new();
        generate_completion(&shell, "boxlite", &mut output);
        let output = String::from_utf8(output).unwrap();
        for command in ["agent", "session", "get-turn", "steer", "interrupt"] {
            assert!(output.contains(command), "{command} missing from {shell:?}");
        }
        let flag_prefix = if matches!(shell, Shell::Fish) {
            "-l "
        } else {
            "--"
        };
        for flag in ["agent-config", "timeout-seconds"] {
            assert!(
                output.contains(&format!("{flag_prefix}{flag}")),
                "{flag} missing from {shell:?}"
            );
        }
        if matches!(shell, Shell::Fish) {
            let wait = output
                .lines()
                .find(|line| line.contains(" -l timeout-seconds "))
                .unwrap();
            assert!(wait.contains("__fish_boxlite_agent_path turn wait"));
            let send = output
                .lines()
                .find(|line| line.contains(" -l mode "))
                .unwrap();
            assert!(send.contains("__fish_boxlite_agent_path session send"));
        }
    }
}

#[test]
fn agents_p0_handler_returns_typed_unsupported() {
    let error = execute(AgentArgs {
        command: parse(&["create", "box", "coder"]),
    })
    .unwrap_err();
    assert!(matches!(
        error.downcast_ref::<BoxliteError>(),
        Some(BoxliteError::Unsupported(_))
    ));
}
