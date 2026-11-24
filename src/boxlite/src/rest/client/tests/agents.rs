use super::*;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

#[tokio::test]
async fn agent_client_controls_require_204_and_forward_errors() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (status, body) in [
            ("204 No Content", ""),
            ("200 OK", "{}"),
            (
                "400 Bad Request",
                r#"{"error":{"message":"not supported","type":"UnsupportedError","code":"unsupported"}}"#,
            ),
        ] {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                header.push(socket.read_u8().await.unwrap());
            }
            let header = String::from_utf8(header).unwrap().to_lowercase();
            let length: usize = header
                .lines()
                .find_map(|line| {
                    line.strip_prefix("content-length:")
                        .map(|v| v.trim().parse().unwrap())
                })
                .unwrap();
            let mut request_body = vec![0; length];
            socket.read_exact(&mut request_body).await.unwrap();
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&request_body).unwrap(),
                serde_json::json!({})
            );
            requests.push(header);
            socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        }
        requests
    });
    let client = ApiClient::new(
        &BoxliteRestOptions::new(format!("http://{address}")).with_api_key("test-key"),
    )
    .unwrap();
    client
        .post_agent_no_content("/agents/a/close", Some("retry-1"))
        .await
        .unwrap();
    assert!(matches!(
        client.post_agent_no_content("/agents/a/close", None).await,
        Err(BoxliteError::Internal(_))
    ));
    assert!(matches!(
        client.post_agent_no_content("/agents/a/close", None).await,
        Err(BoxliteError::Unsupported(_))
    ));
    let requests = server.await.unwrap();
    assert!(requests[0].starts_with("post /v1/agents/a/close http/1.1\r\n"));
    assert!(requests[0].contains("authorization: bearer test-key\r\n"));
    assert!(requests[0].contains("idempotency-key: retry-1\r\n"));
    assert!(!requests[1].contains("idempotency-key:"));
}
#[tokio::test]
async fn agent_client_events_validate_handshake_and_forward_query() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (status, content_type, body) in [
            ("200 OK", "text/event-stream; charset=utf-8", ""),
            ("200 OK", "application/json", "{}"),
            (
                "400 Bad Request",
                "application/json",
                r#"{"error":{"message":"not supported","type":"UnsupportedError","code":"unsupported"}}"#,
            ),
        ] {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                header.push(socket.read_u8().await.unwrap());
            }
            requests.push(String::from_utf8(header).unwrap().to_lowercase());
            socket.write_all(format!("HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
        }
        requests
    });
    let client = ApiClient::new(
        &BoxliteRestOptions::new(format!("http://{address}")).with_api_key("test-key"),
    )
    .unwrap();
    client
        .agent_events("/agents/a/events", Some("cursor 1"), Some("turn/1"))
        .await
        .unwrap();
    assert!(matches!(
        client.agent_events("/agents/a/events", None, None).await,
        Err(BoxliteError::Internal(_))
    ));
    assert!(matches!(
        client.agent_events("/agents/a/events", None, None).await,
        Err(BoxliteError::Unsupported(_))
    ));
    let requests = server.await.unwrap();
    assert!(
        requests[0]
            .starts_with("get /v1/agents/a/events?after=cursor+1&turn_id=turn%2f1 http/1.1\r\n")
    );
    assert!(requests[0].contains("accept: text/event-stream\r\n"));
    assert!(requests[0].contains("authorization: bearer test-key\r\n"));
}
#[tokio::test]
async fn agent_client_rejects_oversized_and_malformed_json() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        for body in [
            vec![b'x'; AGENT_RESPONSE_MAX_BYTES + 1],
            b"{invalid".to_vec(),
        ] {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut header = Vec::new();
            while !header.ends_with(b"\r\n\r\n") {
                header.push(socket.read_u8().await.unwrap());
            }
            socket
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            let _ = socket.write_all(&body).await;
        }
    });
    let client = ApiClient::new(&BoxliteRestOptions::new(format!("http://{address}"))).unwrap();
    let oversize = client.get_agent::<serde_json::Value>("/agents/a").await;
    assert!(matches!(oversize, Err(BoxliteError::ResourceExhausted(_))));
    let malformed = client.get_agent::<serde_json::Value>("/agents/a").await;
    assert!(matches!(malformed, Err(BoxliteError::Internal(_))));
    server.await.unwrap();
}

#[tokio::test]
async fn agent_writes_stop_at_first_redirect() {
    for (code, control) in [(307, false), (308, true)] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = ApiClient::new(&BoxliteRestOptions::new(format!(
            "http://{}",
            listener.local_addr().unwrap()
        )))
        .unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                head.push(socket.read_u8().await.unwrap());
            }
            let mut body = [0; 2];
            socket.read_exact(&mut body).await.unwrap();
            socket.write_all(format!("HTTP/1.1 {code} Redirect\r\nLocation: /unexpected\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
            drop(socket);
            if let Ok(Ok((mut extra, _))) =
                tokio::time::timeout(std::time::Duration::from_secs(1), listener.accept()).await
            {
                let _ = extra
                    .write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n")
                    .await;
                return true;
            }
            false
        });
        if control {
            client
                .post_agent_no_content("/agents/a/close", None)
                .await
                .unwrap_err();
        } else {
            client
                .post_agent::<serde_json::Value>("/agents", &serde_json::json!({}), None)
                .await
                .unwrap_err();
        }
        assert!(
            !server.await.unwrap(),
            "agent write followed a {code} redirect"
        );
    }
}
