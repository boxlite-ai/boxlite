use super::*;

#[test]
fn parser_handles_chunk_boundaries_and_all_line_endings() {
    let mut parser = Parser::default();
    let input = b": keepalive\r\nevent: agent\rdata: {\"text\":\r\ndata: \"hi\"}\n\n";
    let frames: Vec<_> = input
        .iter()
        .filter_map(|byte| parser.feed(*byte).unwrap())
        .collect();
    assert_eq!(
        frames,
        vec![("agent".to_string(), "{\"text\":\n\"hi\"}".to_string())]
    );
    let value: Value = serde_json::from_str(&frames[0].1).unwrap();
    assert_eq!(value["text"], "hi");
}

#[test]
fn parser_rejects_oversized_or_invalid_utf8_lines() {
    let mut parser = Parser::default();
    for _ in 0..MAX_EVENT_BYTES {
        parser.feed(b'x').unwrap();
    }
    assert!(matches!(
        parser.feed(b'x'),
        Err(BoxliteError::ResourceExhausted(_))
    ));
    let mut parser = Parser::default();
    parser.feed(0xff).unwrap();
    assert!(matches!(parser.feed(b'\n'), Err(BoxliteError::Internal(_))));
}

#[test]
fn parser_accepts_initial_utf8_bom() {
    let mut parser = Parser::default();
    let frames: Vec<_> = "\u{feff}data: hello\n\n"
        .bytes()
        .filter_map(|byte| parser.feed(byte).unwrap())
        .collect();
    assert_eq!(frames, vec![(String::new(), "hello".to_string())]);
}

#[tokio::test]
async fn stream_delivers_events_before_one_terminal_error() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut byte = [0];
        while !request.ends_with(b"\r\n\r\n") {
            socket.read_exact(&mut byte).await.unwrap();
            request.push(byte[0]);
        }
        let body = concat!(
            "event: agent\ndata: {\"cursor\":null,\"agent_id\":\"agent-1\",\"turn_id\":null,\"kind\":\"message\",\"data\":{}}\n\n",
            "event: error\ndata: {\"error\":{\"message\":\"stream unavailable\",\"type\":\"UnsupportedError\",\"code\":\"unsupported\"}}\n\n"
        );
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    });
    let client = ApiClient::new(&crate::BoxliteRestOptions::new(format!("http://{addr}"))).unwrap();
    let mut stream = open(
        &client,
        "/boxes/box-1/agents/agent-1",
        "agent-1",
        None,
        &Default::default(),
    )
    .await
    .unwrap();
    assert_eq!(stream.next().await.unwrap().unwrap().kind, "message");
    assert!(matches!(
        stream.next().await.unwrap(),
        Err(BoxliteError::Unsupported(_))
    ));
    assert!(stream.next().await.is_none());
    server.await.unwrap();
}

#[tokio::test]
async fn unknown_event_error_is_bounded() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut byte = [0];
        while !request.ends_with(b"\r\n\r\n") {
            socket.read_exact(&mut byte).await.unwrap();
            request.push(byte[0]);
        }
        let body = format!("event: {}\ndata: {{}}\n\n", "x".repeat(4096));
        socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
    });
    let client = ApiClient::new(&crate::BoxliteRestOptions::new(format!("http://{addr}"))).unwrap();
    let mut stream = open(
        &client,
        "/boxes/box-1/agents/agent-1",
        "agent-1",
        None,
        &Default::default(),
    )
    .await
    .unwrap();
    let error = stream.next().await.unwrap().unwrap_err().to_string();
    assert!(error.contains("unknown agent event type"), "{error}");
    assert!(error.len() < 256, "error contains {} bytes", error.len());
    server.await.unwrap();
}

#[tokio::test]
async fn dropping_stream_closes_the_http_connection() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut request = Vec::new();
        let mut byte = [0];
        while !request.ends_with(b"\r\n\r\n") {
            socket.read_exact(&mut byte).await.unwrap();
            request.push(byte[0]);
        }
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        socket.read(&mut byte).await.unwrap()
    });
    let client = ApiClient::new(&crate::BoxliteRestOptions::new(format!("http://{addr}"))).unwrap();
    let stream = open(
        &client,
        "/boxes/box-1/agents/agent-1",
        "agent-1",
        None,
        &Default::default(),
    )
    .await
    .unwrap();
    drop(stream);
    assert_eq!(
        tokio::time::timeout(std::time::Duration::from_secs(5), server)
            .await
            .unwrap()
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn malformed_event_streams_report_one_terminal_error() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let cases = [
        ("data: not-json\n\n", false, "invalid agent event"),
        ("data: partial", true, "agent event stream failed"),
    ];
    let server = tokio::spawn(async move {
        for (body, truncated, _) in cases {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                header.push(socket.read_u8().await.unwrap());
            }
            let length = body.len() + usize::from(truncated);
            socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n{body}").as_bytes()).await.unwrap();
        }
    });
    let client = ApiClient::new(&crate::BoxliteRestOptions::new(format!("http://{addr}"))).unwrap();
    for (_, _, expected) in cases {
        let mut stream = open(&client, "/boxes/b/agents/a", "a", None, &Default::default())
            .await
            .unwrap();
        let error = stream.next().await.unwrap().unwrap_err();
        assert!(error.to_string().contains(expected), "{error}");
        assert!(stream.next().await.is_none());
    }
    server.await.unwrap();
}

#[tokio::test]
async fn idle_stream_yields_one_network_error() {
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            header.push(socket.read_u8().await.unwrap());
        }
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        let _ = socket.read_u8().await;
    });
    let client = ApiClient::new(&crate::BoxliteRestOptions::new(format!("http://{addr}"))).unwrap();
    let mut stream = open(&client, "/agents/a", "a", None, &Default::default())
        .await
        .unwrap();
    tokio::time::pause();
    let event = tokio::time::timeout(Duration::from_secs(60), stream.next())
        .await
        .expect("silent SSE connection never timed out");
    assert!(matches!(event, Some(Err(BoxliteError::Network(_)))));
    assert!(stream.next().await.is_none());
    server.await.unwrap();
}

#[tokio::test]
async fn heartbeats_keep_an_idle_subscription_open() {
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            header.push(socket.read_u8().await.unwrap());
        }
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        socket
    });
    let client = ApiClient::new(&crate::BoxliteRestOptions::new(format!("http://{addr}"))).unwrap();
    let mut stream = open(&client, "/agents/a", "a", None, &Default::default())
        .await
        .unwrap();
    let mut socket = server.await.unwrap();
    for _ in 0..2 {
        tokio::time::sleep(Duration::from_secs(15)).await;
        socket.write_all(b": heartbeat\n\n").await.unwrap();
    }
    tokio::time::sleep(Duration::from_secs(5)).await;
    socket
        .write_all(b"event: agent\ndata: {\"agent_id\":\"a\",\"kind\":\"message\",\"data\":{}}\n\n")
        .await
        .unwrap();
    let event = tokio::time::timeout(Duration::from_secs(5), stream.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(event.kind, "message");
}

#[tokio::test]
async fn agent_subscription_delivers_opencode_child_then_parent_events() {
    use crate::agents::{opencode::tests::scripted_events, records};
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut native = scripted_events(&[
        json!({"type":"session.created","data":{"parentID":"ses_test","sessionID":"ses_child"}}),
        json!({"type":"session.inbox.enqueued","data":{"sessionID":"ses_child","inboxID":"msg_child"}}),
        json!({"type":"session.inbox.enqueued","data":{"sessionID":"ses_test","inboxID":"msg_parent"}}),
    ]).await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            header.push(socket.read_u8().await.unwrap());
        }
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        while let Some(Ok(event)) = native.next().await {
            let frame = format!("event: agent\ndata: {}\n\n", records::event(&event));
            socket.write_all(frame.as_bytes()).await.unwrap();
        }
    });
    let client = ApiClient::new(&crate::BoxliteRestOptions::new(format!("http://{addr}"))).unwrap();
    let mut stream = open(
        &client,
        "/boxes/box/agents/ses_test",
        "ses_test",
        None,
        &Default::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        stream.next().await.unwrap().unwrap().kind,
        "session.created"
    );
    let child = stream.next().await.unwrap().unwrap();
    assert_eq!(child.agent_id, "ses_test");
    assert_eq!(child.data["data"]["sessionID"], "ses_child");
    assert_eq!(child.turn_id, None);
    let parent = stream.next().await.unwrap().unwrap();
    assert_eq!(parent.agent_id, "ses_test");
    assert_eq!(parent.turn_id.as_deref(), Some("msg_parent"));
    server.await.unwrap();
}
