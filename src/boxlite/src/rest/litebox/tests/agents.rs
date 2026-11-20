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
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        let resource = r#"{"id":"ses_test","agent":"opencode","state":null,"config":{"tools":[],"mcp":[]},"capabilities":{"operations":["agent.send"],"input_kinds":["text"],"max_queued_turns":null,"max_pending_steering":null,"idempotency_retention_seconds":null}}"#;
        let turn = r#"{"id":"msg_test","agent_id":"ses_test","status":"queued","cursor":null,"result":null,"requests":[],"steering":[]}"#;
        let mut requests = Vec::new();
        for response in [resource, turn, turn, turn] {
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
            requests.push((
                header,
                serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
            ));
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
                data: Some(serde_json::Value::Null),
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
                data: Some(serde_json::json!(false)),
                idempotency_key: Some("retry-1".into()),
            },
        )
        .await
        .unwrap();
    let requests = server.await.unwrap();
    for (header, _) in &requests[1..] {
        assert!(header.starts_with("POST /v1/boxes/remote-box/agents/ses_test/turns HTTP/1.1\r\n"));
    }
    assert_eq!(requests[1].1, serde_json::json!({"text":"hello"}));
    assert_eq!(
        requests[2].1,
        serde_json::json!({"text":"hello", "options":{"data":null}})
    );
    assert_eq!(
        requests[3].1,
        serde_json::json!({"text":"hello", "options":{"mode":"reject","data":false}})
    );
    assert!(
        requests[3]
            .0
            .to_ascii_lowercase()
            .contains("idempotency-key: retry-1\r\n")
    );
}
