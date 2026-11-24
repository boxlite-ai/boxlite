use super::*;

#[tokio::test]
async fn remote_agent_get_reports_server_not_found() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = serve_once(
        listener,
        "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
    );
    let rest_box = Arc::new(rest_box_for(port, "remote-box"));
    let agents = crate::Agents::new(rest_box.clone(), rest_box);

    let error = agents.get("ses_test").await.unwrap_err();
    assert!(matches!(error, BoxliteError::NotFound(_)), "{error:?}");
    let request = server.await.unwrap();
    assert!(request.starts_with("GET /v1/boxes/remote-box/agents/ses_test "));
}
#[tokio::test]
async fn remote_agent_get_reads_snapshot_without_state() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let head = read_request_head(&mut socket).await;
        let body = r#"{"id":"ses_test","agent":"opencode","state":null,"config":{"tools":[],"mcp":[],"model":"provider/model"},"capabilities":{"operations":["agent.send"],"input_kinds":["text"],"max_queued_turns":null,"max_pending_steering":null,"idempotency_retention_seconds":null}}"#;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        socket.write_all(response.as_bytes()).await.unwrap();
        String::from_utf8(head).unwrap()
    });
    let rest_box = Arc::new(rest_box_for(port, "remote-box"));
    let agents = crate::Agents::new(rest_box.clone(), rest_box);
    let agent = agents.get("ses_test").await.unwrap();
    assert_eq!(agent.id(), "ses_test");
    assert_eq!(
        agent.config().unwrap().model.as_deref(),
        Some("provider/model")
    );
    assert!(matches!(agent.state(), Err(BoxliteError::Unsupported(_))));
    assert!(
        agent
            .capabilities()
            .unwrap()
            .operations
            .contains(&"agent.send".to_owned())
    );
    assert!(
        server
            .await
            .unwrap()
            .starts_with("GET /v1/boxes/remote-box/agents/ses_test ")
    );
}
#[tokio::test]
async fn remote_agent_create_send_and_get_turn() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let resource = r#"{"id":"ses_test","agent":"opencode","state":null,"config":{"tools":[],"mcp":[]},"capabilities":{"operations":["agent.send"],"input_kinds":["text"],"max_queued_turns":null,"max_pending_steering":null,"idempotency_retention_seconds":null}}"#;
        let turn = r#"{"id":"msg_test","agent_id":"ses_test","status":"queued","cursor":null,"result":null,"requests":[],"steering":[]}"#;
        for (expected, response) in [
            ("POST /v1/boxes/remote-box/agents ", resource),
            ("POST /v1/boxes/remote-box/agents/ses_test/turns ", turn),
            (
                "GET /v1/boxes/remote-box/agents/ses_test/turns/msg_test ",
                turn,
            ),
        ] {
            let (mut socket, _) = listener.accept().await.unwrap();
            let head = read_request_head(&mut socket).await;
            assert!(String::from_utf8_lossy(&head).starts_with(expected));
            let reply = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                response.len()
            );
            socket.write_all(reply.as_bytes()).await.unwrap();
        }
    });
    let rest_box = Arc::new(rest_box_for(port, "remote-box"));
    let agents = crate::Agents::new(rest_box.clone(), rest_box);
    let agent = agents
        .create("opencode", crate::agents::AgentCreateOptions::default())
        .await
        .unwrap();
    let turn = agent
        .send("hello", crate::agents::AgentSendOptions::default())
        .await
        .unwrap();
    assert_eq!(turn.state().unwrap().id, "msg_test");
    assert_eq!(
        agent
            .get_turn("msg_test")
            .await
            .unwrap()
            .state()
            .unwrap()
            .agent_id,
        "ses_test"
    );
    server.await.unwrap();
}
#[tokio::test]
async fn remote_agent_send_preserves_optional_request_values() {
    use crate::agents::{AgentSendMode, AgentSendOptions};
    const RAW_DATA: &str = r#"{ "$serde_json::private::Number": "ordinary key", "number": 1e400 }"#;
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let resource = r#"{"id":"ses_test","agent":"opencode","state":null,"config":{"tools":[],"mcp":[]},"capabilities":{"operations":["agent.send"],"input_kinds":["text"],"max_queued_turns":null,"max_pending_steering":null,"idempotency_retention_seconds":null}}"#;
        let turn = r#"{"id":"msg_test","agent_id":"ses_test","status":"queued","cursor":null,"result":null,"requests":[],"steering":[]}"#;
        let mut requests = Vec::new();
        for response in [resource, turn, turn, turn, turn] {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                header.push(socket.read_u8().await.unwrap());
            }
            let header = String::from_utf8(header).unwrap();
            let length: usize = header
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .map(|value| value.trim().parse().unwrap())
                })
                .unwrap();
            let mut body = vec![0; length];
            socket.read_exact(&mut body).await.unwrap();
            requests.push((header, String::from_utf8(body).unwrap()));
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len()).as_bytes()).await.unwrap();
        }
        requests
    });
    let rest_box = Arc::new(rest_box_for(port, "remote-box"));
    let agent = crate::Agents::new(rest_box.clone(), rest_box)
        .create("opencode", Default::default())
        .await
        .unwrap();
    agent
        .send("hello", AgentSendOptions::default())
        .await
        .unwrap();
    agent
        .send(
            "hello",
            AgentSendOptions {
                mode: AgentSendMode::Queue,
                data: Some(serde_json::value::to_raw_value(&serde_json::Value::Null).unwrap()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    agent
        .send(
            "hello",
            AgentSendOptions {
                mode: AgentSendMode::Reject,
                data: Some(serde_json::value::to_raw_value(&serde_json::json!(false)).unwrap()),
                idempotency_key: Some("retry-1".into()),
            },
        )
        .await
        .unwrap();
    agent
        .send(
            "raw",
            AgentSendOptions {
                data: Some(serde_json::value::RawValue::from_string(RAW_DATA.into()).unwrap()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let requests = server.await.unwrap();
    for (header, _) in &requests[1..] {
        assert!(header.starts_with("POST /v1/boxes/remote-box/agents/ses_test/turns HTTP/1.1\r\n"));
    }
    assert!(requests[4].1.contains(RAW_DATA));
    let body = |i: usize| serde_json::from_str::<serde_json::Value>(&requests[i].1).unwrap();
    assert_eq!(body(1), serde_json::json!({"text":"hello"}));
    assert_eq!(
        body(2),
        serde_json::json!({"text":"hello", "options":{"data":null}})
    );
    assert_eq!(
        body(3),
        serde_json::json!({"text":"hello", "options":{"mode":"reject","data":false}})
    );
    assert!(
        requests[3]
            .0
            .to_ascii_lowercase()
            .contains("idempotency-key: retry-1\r\n")
    );
}

const RESOURCE: &str = r#"{"id":"ses_test","agent":"opencode","config":{"tools":[],"mcp":[]},"capabilities":{"operations":["agent.respond"],"input_kinds":["text"],"idempotency_retention_seconds":0.5}}"#;
const TURN: &str =
    r#"{"id":"msg_test","agent_id":"ses_test","status":"queued","requests":[],"steering":[]}"#;

async fn agent_exchange(
    listener: &TcpListener,
    expected: &str,
    expected_body: Option<serde_json::Value>,
    content_type: &str,
    status: &str,
    body: &str,
) -> String {
    let (mut socket, _) = listener.accept().await.unwrap();
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        header.push(socket.read_u8().await.unwrap());
    }
    let header = String::from_utf8(header).unwrap();
    assert_eq!(
        header.lines().next().unwrap(),
        format!("{expected} HTTP/1.1")
    );
    if let Some(expected_body) = expected_body {
        let length = header
            .lines()
            .find_map(|line| {
                let (key, value) = line.split_once(':')?;
                key.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().unwrap())
            })
            .unwrap();
        let mut bytes = vec![0; length];
        socket.read_exact(&mut bytes).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
            expected_body
        );
    }
    let reply = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    socket.write_all(reply.as_bytes()).await.unwrap();
    header
}

#[tokio::test]
async fn remote_controls_forward_typed_responses_and_confirm_shutdown() {
    use crate::agents::{AgentResponse, AgentSteeringStatus};
    use serde_json::json;
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let sandbox = Arc::new(rest_box_for(listener.local_addr().unwrap().port(), "box"));
    let server = tokio::spawn(async move {
        let base = "/v1/boxes/box/agents/ses_test";
        agent_exchange(
            &listener,
            &format!("GET {base}"),
            None,
            "application/json",
            "200 OK",
            RESOURCE,
        )
        .await;
        for (path, body, reply) in [
            (
                "requests/question/respond",
                json!({"response":{"type":"answer","text":"yes","data":42}}),
                TURN,
            ),
            (
                "requests/permission/respond",
                json!({"response":{"type":"permission","approved":false}}),
                TURN,
            ),
            (
                "turns/msg_test/steer",
                json!({"text":"stop editing"}),
                r#"{"id":"receipt","turn_id":"msg_test","status":"accepted"}"#,
            ),
            ("turns/msg_test/interrupt", json!({}), ""),
            ("close", json!({}), ""),
        ] {
            let status = if reply.is_empty() {
                "204 No Content"
            } else {
                "200 OK"
            };
            agent_exchange(
                &listener,
                &format!("POST {base}/{path}"),
                Some(body),
                "application/json",
                status,
                reply,
            )
            .await;
        }
    });
    let agent = crate::Agents::new(sandbox.clone(), sandbox)
        .get("ses_test")
        .await
        .unwrap();
    let answer = AgentResponse::Answer {
        text: "yes".into(),
        data: Some(serde_json::value::to_raw_value(&json!(42)).unwrap()),
    };
    let turn = agent
        .respond("question", answer, Default::default())
        .await
        .unwrap();
    assert_eq!(turn.state().unwrap().id, "msg_test");
    let turn = agent
        .respond(
            "permission",
            AgentResponse::Permission { approved: false },
            Default::default(),
        )
        .await
        .unwrap();
    let receipt = turn
        .steer("stop editing", Default::default())
        .await
        .unwrap();
    assert_eq!(receipt.status, AgentSteeringStatus::Accepted);
    turn.interrupt(Default::default()).await.unwrap();
    agent.close(Default::default()).await.unwrap();
    server.await.unwrap();
}

#[tokio::test]
async fn remote_turn_events_reject_wrong_parent_and_report_disconnect() {
    use futures::StreamExt;
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let sandbox = Arc::new(rest_box_for(listener.local_addr().unwrap().port(), "box"));
    let server = tokio::spawn(async move {
        let base = "/v1/boxes/box/agents/ses_test";
        agent_exchange(
            &listener,
            &format!("GET {base}"),
            None,
            "application/json",
            "200 OK",
            RESOURCE,
        )
        .await;
        agent_exchange(
            &listener,
            &format!("GET {base}/turns/msg_test"),
            None,
            "application/json",
            "200 OK",
            TURN,
        )
        .await;
        agent_exchange(&listener, &format!("GET {base}/events?turn_id=msg_test"), None, "text/event-stream", "200 OK",
            "data: {\"agent_id\":\"ses_test\",\"turn_id\":\"other\",\"kind\":\"message\",\"data\":{}}\n\n").await;
        agent_exchange(
            &listener,
            &format!("GET {base}/events"),
            None,
            "text/event-stream",
            "200 OK",
            ": heartbeat\n\n",
        )
        .await;
    });
    let agent = crate::Agents::new(sandbox.clone(), sandbox)
        .get("ses_test")
        .await
        .unwrap();
    let turn = agent.get_turn("msg_test").await.unwrap();
    let mut stream = turn.events(Default::default()).await.unwrap();
    assert!(
        matches!(stream.next().await, Some(Err(BoxliteError::Internal(message))) if message.contains("wrong parent"))
    );
    assert!(stream.next().await.is_none());
    let mut stream = agent.events(Default::default()).await.unwrap();
    assert!(
        matches!(stream.next().await, Some(Err(BoxliteError::Network(message))) if message.contains("ended"))
    );
    assert!(stream.next().await.is_none());
    server.await.unwrap();
}

#[tokio::test]
async fn remote_handles_reject_responses_for_other_resources() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let sandbox = Arc::new(rest_box_for(listener.local_addr().unwrap().port(), "box"));
    let server = tokio::spawn(async move {
        for (path, body) in [
            ("other", RESOURCE.to_owned()),
            ("ses_test", RESOURCE.to_owned()),
            ("ses_test/turns/other", TURN.to_owned()),
            ("ses_test/turns/msg_test", TURN.replace("ses_test", "other")),
        ] {
            agent_exchange(
                &listener,
                &format!("GET /v1/boxes/box/agents/{path}"),
                None,
                "application/json",
                "200 OK",
                &body,
            )
            .await;
        }
    });
    let agents = crate::Agents::new(sandbox.clone(), sandbox);
    assert!(matches!(
        agents.get("..").await,
        Err(BoxliteError::InvalidArgument(_))
    ));
    assert!(matches!(
        agents.get("other").await,
        Err(BoxliteError::Internal(_))
    ));
    let agent = agents.get("ses_test").await.unwrap();
    for id in ["other", "msg_test"] {
        assert!(matches!(
            agent.get_turn(id).await,
            Err(BoxliteError::Internal(_))
        ));
    }
    server.await.unwrap();
}

#[tokio::test]
async fn wait_requires_matching_terminal_status() {
    for (status, result_status) in [
        ("running", "completed"),
        ("failed", "completed"),
        ("unknown", "unknown"),
    ] {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let sandbox = Arc::new(rest_box_for(listener.local_addr().unwrap().port(), "box"));
        let server = tokio::spawn(async move {
            agent_exchange(
                &listener,
                "GET /v1/boxes/box/agents/ses_test",
                None,
                "application/json",
                "200 OK",
                RESOURCE,
            )
            .await;
            let path = "GET /v1/boxes/box/agents/ses_test/turns/msg_test";
            agent_exchange(&listener, path, None, "application/json", "200 OK", TURN).await;
            let mut snapshot: serde_json::Value = serde_json::from_str(TURN).unwrap();
            snapshot["status"] = serde_json::json!(status);
            snapshot["result"] =
                serde_json::json!({"turn_id":"msg_test","status":result_status,"artifacts":[]});
            agent_exchange(
                &listener,
                path,
                None,
                "application/json",
                "200 OK",
                &snapshot.to_string(),
            )
            .await;
        });
        let agent = crate::Agents::new(sandbox.clone(), sandbox)
            .get("ses_test")
            .await
            .unwrap();
        let turn = agent.get_turn("msg_test").await.unwrap();
        assert!(
            matches!(
                turn.wait(Default::default()).await,
                Err(BoxliteError::InvalidState(_))
            ),
            "accepted result for {status} snapshot"
        );
        server.await.unwrap();
    }
}

#[tokio::test]
async fn remote_create_forwards_config_cwd_and_retry_key() {
    use crate::agents::{AgentConfig, AgentCreateOptions};
    use serde_json::json;
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let sandbox = Arc::new(rest_box_for(listener.local_addr().unwrap().port(), "box"));
    let server = tokio::spawn(async move {
        let header = agent_exchange(
            &listener,
            "POST /v1/boxes/box/agents",
            Some(json!({
                "agent":"opencode","options":{"cwd":"/workspace","config":{
                    "permissions":{"edit":"deny"},"limits":{"max_steps":3},"tools":[],"mcp":[]
                }}
            })),
            "application/json",
            "201 Created",
            RESOURCE,
        )
        .await;
        let keys: Vec<_> = header
            .lines()
            .filter_map(|line| line.split_once(':'))
            .filter(|(name, _)| name.eq_ignore_ascii_case("Idempotency-Key"))
            .map(|(_, value)| value.trim())
            .collect();
        assert_eq!(keys, ["create-42"]);
    });
    let options = AgentCreateOptions {
        cwd: Some("/workspace".into()),
        config: AgentConfig {
            permissions: Some(json!({"edit":"deny"})),
            limits: Some(json!({"max_steps":3})),
            ..Default::default()
        },
        idempotency_key: Some("create-42".into()),
    };
    let agent = crate::Agents::new(sandbox.clone(), sandbox)
        .create("opencode", options)
        .await
        .unwrap();
    assert_eq!(agent.id(), "ses_test");
    server.await.unwrap();
}
