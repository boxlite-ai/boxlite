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
