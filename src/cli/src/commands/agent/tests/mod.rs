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
fn agents_create_groups_options_and_keeps_runtime_config_separate() {
    let cli = try_parse_from([
        "boxlite",
        "agent",
        "create",
        "box",
        "--agent",
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

    let AgentCommand::Create { target, agent, .. } = parse(&["create", "--agent", "coder", "box"])
    else {
        panic!("expected create")
    };
    assert_eq!(target.target, "box");
    assert_eq!(agent, "coder");
}

#[test]
fn agents_send_defaults_to_queue_and_accepts_reject_and_json() {
    let AgentCommand::Send { options, .. } = parse(&["send", "box", "--agent", "agent", "hello"])
    else {
        panic!("expected send")
    };
    assert_eq!(options.mode, SendMode::Queue);
    assert_eq!(options.data, None);
    assert_eq!(options.control.idempotency_key, None);

    let AgentCommand::Send {
        target,
        text,
        options,
    } = parse(&[
        "send",
        "box",
        "--agent",
        "agent",
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
    assert_eq!(target.agent_id, "agent");
    assert_eq!(text, "hello");
    assert_eq!(options.mode, SendMode::Reject);
    assert_eq!(options.data, Some(json!({"value": 1})));
    assert_eq!(options.control.idempotency_key.as_deref(), Some("retry"));
}

#[test]
fn agents_turn_options_preserve_target_timeout_cursor_and_retry_key() {
    let AgentCommand::Wait { target, options } = parse(&[
        "wait",
        "box",
        "--agent",
        "agent",
        "--turn",
        "turn",
        "--timeout-seconds",
        "0",
    ]) else {
        panic!("expected wait")
    };
    assert_eq!(target.agent.sandbox.target, "box");
    assert_eq!(target.agent.agent_id, "agent");
    assert_eq!(target.turn, "turn");
    assert_eq!(options.timeout_seconds, Some(0));

    let AgentCommand::Wait { options, .. } =
        parse(&["wait", "box", "--agent", "agent", "--turn", "turn"])
    else {
        panic!("expected wait")
    };
    assert_eq!(options.timeout_seconds, None);

    let AgentCommand::Events { target, options } = parse(&[
        "events", "box", "--agent", "agent", "--turn", "turn", "--after", "cursor",
    ]) else {
        panic!("expected events")
    };
    assert_eq!(options.after.as_deref(), Some("cursor"));
    assert_eq!(target.turn.as_deref(), Some("turn"));

    let AgentCommand::Steer { text, options, .. } = parse(&[
        "steer",
        "box",
        "--agent",
        "agent",
        "--turn",
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
fn agents_responses_keep_answer_and_permission_json_distinct() {
    for response in [
        r#"{"type":"answer","text":"yes"}"#,
        r#"{"type":"permission","approved":false}"#,
    ] {
        let AgentCommand::Respond {
            request,
            response: parsed,
            options,
            ..
        } = parse(&[
            "respond",
            "box",
            "--agent",
            "agent",
            "--request",
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
fn agents_inspection_selects_state_or_an_agent_view() {
    for (extra, turn, view) in [
        (vec![], None, None),
        (vec!["--turn", "turn"], Some("turn"), None),
        (vec!["--view", "config"], None, Some(AgentView::Config)),
        (
            vec!["--view", "capabilities"],
            None,
            Some(AgentView::Capabilities),
        ),
        (vec!["--view", "requests"], None, Some(AgentView::Requests)),
    ] {
        let mut args = vec!["inspect", "box", "--agent", "agent"];
        args.extend(extra);
        let AgentCommand::Inspect { target, options } = parse(&args) else {
            panic!("expected inspect");
        };
        assert_eq!(target.agent.sandbox.target, "box");
        assert_eq!(target.agent.agent_id, "agent");
        assert_eq!(target.turn.as_deref(), turn);
        assert_eq!(options.view, view);
    }
    for view in ["config", "capabilities", "requests"] {
        let error = try_parse_from([
            "boxlite", "agent", "inspect", "box", "--agent", "agent", "--turn", "turn", "--view",
            view,
        ])
        .unwrap_err();
        assert_eq!(error.kind(), ErrorKind::ArgumentConflict);
    }
}

#[test]
fn agents_parser_rejects_invalid_options_and_missing_targets() {
    let cases: &[(&[&str], ErrorKind)] = &[
        (&["create", "box"], ErrorKind::MissingRequiredArgument),
        (
            &["create", "--agent", "coder"],
            ErrorKind::MissingRequiredArgument,
        ),
        (&["create", "box", "coder"], ErrorKind::UnknownArgument),
        (
            &["send", "box", "--session", "agent", "text"],
            ErrorKind::UnknownArgument,
        ),
        (
            &["create", "box", "--agent", "coder", "--name", "worker"],
            ErrorKind::UnknownArgument,
        ),
        (
            &[
                "create",
                "box",
                "--agent",
                "coder",
                "--agent-config",
                "not-json",
            ],
            ErrorKind::ValueValidation,
        ),
        (
            &[
                "send",
                "box",
                "--agent",
                "agent",
                "text",
                "--mode",
                "interrupt",
            ],
            ErrorKind::InvalidValue,
        ),
        (
            &["send", "box", "--agent", "agent", "text", "--data", "{"],
            ErrorKind::ValueValidation,
        ),
        (
            &[
                "respond",
                "box",
                "--agent",
                "agent",
                "--request",
                "request",
                "not-json",
            ],
            ErrorKind::ValueValidation,
        ),
        (
            &["steer", "box", "--agent", "agent", "--turn", "turn"],
            ErrorKind::MissingRequiredArgument,
        ),
        (
            &[
                "wait",
                "box",
                "--agent",
                "agent",
                "--turn",
                "turn",
                "--timeout-seconds=-1",
            ],
            ErrorKind::ValueValidation,
        ),
        (
            &[
                "wait",
                "box",
                "--agent",
                "agent",
                "--turn",
                "turn",
                "--timeout-seconds=NaN",
            ],
            ErrorKind::ValueValidation,
        ),
        (
            &[
                "inspect",
                "box",
                "--agent",
                "agent",
                "--registry",
                "irrelevant.test",
            ],
            ErrorKind::UnknownArgument,
        ),
    ];
    for (args, expected) in cases {
        let error = try_parse_from(["boxlite", "agent"].iter().chain(args.iter())).unwrap_err();
        assert_eq!(&error.kind(), expected, "{args:?}");
    }
}

#[test]
fn agents_help_and_completion_include_nine_flat_commands() {
    let mut command = crate::cli::command();
    command.build();
    let agent = command.find_subcommand_mut("agent").unwrap();
    assert_eq!(
        agent
            .get_subcommands()
            .filter(|command| command.get_name() != "help")
            .count(),
        9
    );
    for name in [
        "create",
        "close",
        "send",
        "inspect",
        "events",
        "respond",
        "wait",
        "steer",
        "interrupt",
    ] {
        assert!(agent.find_subcommand(name).is_some(), "{name}");
    }
    for unsupported in ["agent", "turn", "get", "get-turn"] {
        assert!(
            agent.find_subcommand(unsupported).is_none(),
            "{unsupported}"
        );
    }
    let create_help = agent
        .find_subcommand_mut("create")
        .unwrap()
        .render_long_help()
        .to_string();
    let usage = create_help
        .lines()
        .find(|line| line.starts_with("Usage:"))
        .unwrap();
    assert!(usage.contains("--agent <IMPLEMENTATION>"), "{usage}");
    assert!(usage.contains("<BOX>"), "{usage}");
    assert!(!create_help.contains("--name"), "{create_help}");
    let help = agent
        .find_subcommand_mut("send")
        .unwrap()
        .render_long_help()
        .to_string();
    for text in [
        "Submit text and optional JSON data",
        "<BOX>",
        "--agent <AGENT>",
        "<TEXT>",
        "--mode",
        "--data",
        "--idempotency-key",
    ] {
        assert!(help.contains(text), "{text}: {help}");
    }
    assert!(!help.contains("--registry"));
    assert!(!help.contains("--session"));
    for shell in [Shell::Bash, Shell::Zsh, Shell::Fish] {
        let mut output = Vec::new();
        generate_completion(&shell, "boxlite", &mut output);
        let output = String::from_utf8(output).unwrap();
        for command in ["agent", "inspect", "events", "steer", "interrupt"] {
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
        let agent_flag = match shell {
            Shell::Bash => "--agent ",
            Shell::Zsh => "--agent=",
            Shell::Fish => "-l agent ",
        };
        assert!(
            output.contains(agent_flag),
            "--agent missing from {shell:?}"
        );
        if matches!(shell, Shell::Fish) {
            let create = output
                .lines()
                .find(|line| {
                    line.contains(" -l agent ") && line.contains("__fish_boxlite_agent_path create")
                })
                .unwrap();
            assert!(create.contains("__fish_boxlite_agent_path create"));
            let wait = output
                .lines()
                .find(|line| line.contains(" -l timeout-seconds "))
                .unwrap();
            assert!(wait.contains("__fish_boxlite_agent_path wait"));
            let send = output
                .lines()
                .find(|line| line.contains(" -l mode "))
                .unwrap();
            assert!(send.contains("__fish_boxlite_agent_path send"));
        }
    }
}

/// Records use the field names and enum strings documented under "C JSON fields".
#[test]
fn agents_records_use_documented_json_shapes() {
    use boxlite::agents::{
        AgentOutcome, AgentRequest, AgentRequestKind, AgentResult, AgentState, AgentStatus,
        AgentSteeringReceipt, AgentSteeringStatus, AgentTurnState, AgentTurnStatus,
    };
    let request = AgentRequest {
        id: "req".into(),
        turn_id: "msg".into(),
        kind: AgentRequestKind::Permission {
            tool: "bash".into(),
            arguments: json!({"command": "ls"}),
        },
    };
    let receipt = AgentSteeringReceipt {
        id: "steer".into(),
        turn_id: "msg".into(),
        status: AgentSteeringStatus::Applied,
    };
    let state = AgentState {
        id: "ses".into(),
        status: AgentStatus::Busy,
        cursor: None,
        active_turn_id: Some("msg".into()),
        queued_turn_ids: vec!["next".into()],
        requests: vec![request.clone()],
        steering: vec![receipt.clone()],
    };
    assert_eq!(
        records::agent_state(&state),
        json!({
            "id": "ses", "status": "busy", "cursor": null, "active_turn_id": "msg",
            "queued_turn_ids": ["next"],
            "requests": [{"id": "req", "turn_id": "msg",
                "kind": {"type": "permission", "tool": "bash", "arguments": {"command": "ls"}}}],
            "steering": [{"id": "steer", "turn_id": "msg", "status": "applied"}],
        })
    );

    let result = AgentResult {
        turn_id: "msg".into(),
        status: AgentTurnStatus::WaitingInput,
        outcome: Some(AgentOutcome::Question),
        text: Some("which file?".into()),
        data: None,
        artifacts: vec![],
        usage: None,
        error: None,
    };
    let turn = AgentTurnState {
        id: "msg".into(),
        agent_id: "ses".into(),
        status: AgentTurnStatus::WaitingInput,
        cursor: Some("c1".into()),
        result: Some(result),
        requests: vec![],
        steering: vec![],
    };
    assert_eq!(
        records::turn_state(&turn),
        json!({
            "id": "msg", "agent_id": "ses", "status": "waiting_input", "cursor": "c1",
            "result": {"turn_id": "msg", "status": "waiting_input", "outcome": "question",
                "text": "which file?", "data": null, "artifacts": [], "usage": null, "error": null},
            "requests": [], "steering": [],
        })
    );
}

#[test]
fn agents_config_and_capabilities_records_omit_or_null_unknowns() {
    use boxlite::agents::{AgentCapabilities, AgentConfig};
    use std::time::Duration;
    let config = AgentConfig {
        model: Some("fake/fake-model".into()),
        ..AgentConfig::default()
    };
    assert_eq!(
        records::config(&config),
        json!({"model": "fake/fake-model", "tools": [], "mcp": []})
    );
    let capabilities = AgentCapabilities {
        operations: vec!["agent.send".into()],
        input_kinds: vec!["text".into()],
        max_queued_turns: None,
        max_pending_steering: Some(1),
        idempotency_retention: Some(Duration::from_millis(1500)),
    };
    assert_eq!(
        records::capabilities(&capabilities),
        json!({"operations": ["agent.send"], "input_kinds": ["text"], "max_queued_turns": null,
            "max_pending_steering": 1, "idempotency_retention_seconds": 1.5})
    );
}

#[test]
fn agents_respond_parses_answers_and_permissions_and_rejects_other_shapes() {
    use boxlite::BoxliteError;
    use boxlite::agents::AgentResponse;
    assert!(matches!(
        records::parse_response(json!({"type": "answer", "text": "yes", "data": {"n": 1}})),
        Ok(AgentResponse::Answer { text, data: Some(data) }) if text == "yes" && data == json!({"n": 1})
    ));
    assert!(matches!(
        records::parse_response(json!({"type": "permission", "approved": false})),
        Ok(AgentResponse::Permission { approved: false })
    ));
    for invalid in [
        json!({"type": "answer"}),
        json!({"type": "permission", "approved": "yes"}),
        json!({"type": "vote", "approved": true}),
        json!({"type": "answer", "text": "yes", "extra": 1}),
        json!("yes"),
    ] {
        assert!(
            matches!(
                records::parse_response(invalid.clone()),
                Err(BoxliteError::InvalidArgument(_))
            ),
            "accepted {invalid}"
        );
    }
}

#[test]
fn agents_config_parses_documented_fields_and_rejects_unknown_ones() {
    use boxlite::BoxliteError;
    let config =
        records::parse_config(json!({"model": "fake/fake-model", "tools": ["bash"]})).unwrap();
    assert_eq!(config.model.as_deref(), Some("fake/fake-model"));
    assert_eq!(config.tools, ["bash"]);
    assert!(config.mcp.is_empty());
    assert!(matches!(
        records::parse_config(json!({"modle": "typo"})),
        Err(BoxliteError::InvalidArgument(message)) if message.contains("modle")
    ));
}

/// The agent-level OpenCode stream always ends in an error: every earlier
/// record must already be written when that error reaches the caller.
#[tokio::test]
async fn agents_events_print_every_record_before_the_stream_error() {
    use boxlite::BoxliteError;
    use boxlite::agents::AgentEvent;
    let event = |kind: &str| {
        Ok(AgentEvent {
            cursor: None,
            agent_id: "ses".into(),
            turn_id: None,
            kind: kind.into(),
            data: json!({}),
        })
    };
    let stream: AgentEventStream = Box::pin(futures::stream::iter([
        event("session.status"),
        event("session.idle"),
        Err(BoxliteError::Network("OpenCode event stream ended".into())),
    ]));
    let mut out = Vec::new();
    let error = print_events(stream, &mut out).await.unwrap_err();
    assert!(matches!(
        error.downcast_ref::<BoxliteError>(),
        Some(BoxliteError::Network(_))
    ));
    let kinds: Vec<Value> = String::from_utf8(out)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap()["kind"].clone())
        .collect();
    assert_eq!(kinds, [json!("session.status"), json!("session.idle")]);
}
