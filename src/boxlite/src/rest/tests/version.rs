//! Exercise the production transport against loopback HTTP, without a VM.
use super::*;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

async fn read_request(socket: &mut TcpStream) -> (String, Value) {
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        bytes.push(socket.read_u8().await.unwrap());
    }
    let headers = String::from_utf8(bytes).unwrap();
    let length = headers
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    let mut body = vec![0; length];
    socket.read_exact(&mut body).await.unwrap();
    (
        headers,
        if body.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&body).unwrap()
        },
    )
}

async fn respond(socket: &mut TcpStream, status: u16, body: &str) {
    socket.write_all(format!(
        "HTTP/1.1 {status} Reply\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()).as_bytes()).await.unwrap();
}

async fn server(
    replies: Vec<(u16, String)>,
) -> (
    BoxliteRestOptions,
    tokio::task::JoinHandle<Vec<(String, Value)>>,
) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let options = BoxliteRestOptions::new(format!("http://{}", listener.local_addr().unwrap()));
    let task = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (status, body) in replies {
            let (mut socket, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
                .await
                .unwrap()
                .unwrap();
            requests.push(read_request(&mut socket).await);
            respond(&mut socket, status, &body).await;
        }
        requests
    });
    (options, task)
}

async fn exec_user(client: &ApiClient) -> BoxliteResult<Value> {
    client
        .post(
            "/boxes/id/exec",
            &json!({"command":"id", "user":"1000:1000"}),
        )
        .await
}

#[tokio::test]
async fn semver_boundaries_and_untrusted_discovery() {
    for (reported, accepted) in [
        (json!("0.11.99"), false),
        (json!("0.12.0-rc.1"), false),
        (json!("0.12.0"), true),
        (json!("0.12.0+build.42"), true),
        (json!("1.0.0"), true),
        (Value::Null, false),
        (json!(12), false),
        (json!("0.12"), false),
        (json!("v0.12.0"), false),
    ] {
        let mut replies = vec![(
            200,
            json!({"api_version":reported,"capabilities":{"exec_user_enabled":false}}).to_string(),
        )];
        if accepted {
            replies.push((200, "{}".into()));
        }
        let (options, task) = server(replies).await;
        let result = exec_user(&ApiClient::new(&options).unwrap()).await;
        if accepted {
            result.unwrap();
        } else {
            let error = result.unwrap_err();
            assert!(
                matches!(error, BoxliteError::Unsupported(_)),
                "{reported}: {error}"
            );
            assert!(
                error
                    .to_string()
                    .contains("startExecution (body.user) requires server >= 0.12.0")
            );
        }
        let requests = task.await.unwrap();
        assert!(requests[0].0.starts_with("GET /v1/config HTTP/1.1"));
        assert_eq!(requests.len(), if accepted { 2 } else { 1 });
        if accepted {
            assert_eq!(requests[1].1["user"], "1000:1000");
        }
    }
}

#[tokio::test]
async fn failed_discovery_retries_and_keeps_http_error_classes() {
    for (status, body) in [
        (401, "{}"),
        (403, "{}"),
        (503, "{}"),
        (200, "{}"),
        (200, r#"{"api_version":"garbage"}"#),
    ] {
        let (options, task) = server(vec![
            (status, body.into()),
            (200, r#"{"api_version":"0.12.0"}"#.into()),
            (200, "{}".into()),
        ])
        .await;
        let client = ApiClient::new(&options).unwrap();
        let error = exec_user(&client).await.unwrap_err();
        match status {
            401 | 403 => assert!(matches!(error, BoxliteError::Config(_))),
            503 => assert!(matches!(error, BoxliteError::Network(_))),
            _ => assert!(matches!(error, BoxliteError::Unsupported(_))),
        }
        exec_user(&client).await.unwrap();
        let requests = task.await.unwrap();
        assert!(requests[0].0.starts_with("GET /v1/config "));
        assert!(requests[1].0.starts_with("GET /v1/config "));
        assert!(requests[2].0.starts_with("POST /v1/boxes/id/exec "));
    }
}

#[tokio::test]
async fn concurrent_clones_share_discovery_and_new_clients_discover_again() {
    let mut replies = vec![(200, r#"{"api_version":"0.12.0"}"#.into())];
    replies.extend((0..9).map(|_| (200, "{}".into())));
    replies.extend([(200, r#"{"api_version":"0.11.0"}"#.into())]);
    let (options, task) = server(replies).await;
    let client = ApiClient::new(&options).unwrap();
    let mut callers = tokio::task::JoinSet::new();
    for _ in 0..8 {
        let client = client.clone();
        callers.spawn(async move { exec_user(&client).await.unwrap() });
    }
    while let Some(result) = callers.join_next().await {
        result.unwrap();
    }
    exec_user(&client).await.unwrap();
    let new_client = ApiClient::new(&options).unwrap();
    assert!(matches!(
        exec_user(&new_client).await,
        Err(BoxliteError::Unsupported(_))
    ));
    // A supported parse is cached even when it refuses the operation.
    assert!(matches!(
        exec_user(&new_client).await,
        Err(BoxliteError::Unsupported(_))
    ));
    let requests = task.await.unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|(h, _)| h.starts_with("GET /v1/config "))
            .count(),
        2
    );
}

#[tokio::test]
async fn cancelled_discovery_does_not_poison_the_client() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let client = ApiClient::new(&BoxliteRestOptions::new(format!(
        "http://{}",
        listener.local_addr().unwrap()
    )))
    .unwrap();
    let clone = client.clone();
    let call = tokio::spawn(async move { exec_user(&clone).await });
    let (mut socket, _) = listener.accept().await.unwrap();
    assert!(
        read_request(&mut socket)
            .await
            .0
            .starts_with("GET /v1/config ")
    );
    call.abort();
    assert!(call.await.unwrap_err().is_cancelled());
    drop(socket);
    let retry = tokio::spawn(async move { exec_user(&client).await });
    let (mut socket, _) = listener.accept().await.unwrap();
    assert!(
        read_request(&mut socket)
            .await
            .0
            .starts_with("GET /v1/config ")
    );
    respond(&mut socket, 200, r#"{"api_version":"0.12.0"}"#).await;
    let (mut socket, _) = listener.accept().await.unwrap();
    assert!(
        read_request(&mut socket)
            .await
            .0
            .starts_with("POST /v1/boxes/id/exec ")
    );
    respond(&mut socket, 200, "{}").await;
    retry.await.unwrap().unwrap();
}

#[tokio::test]
async fn defaults_are_sent_unchanged_without_discovery() {
    let bodies = [
        json!({"advanced":{"privileged":false}}),
        json!({"command":"id"}),
    ];
    let (options, task) = server(vec![(200, "{}".into()), (200, "{}".into())]).await;
    let client = ApiClient::new(&options).unwrap();
    for (path, body) in ["/boxes", "/boxes/id/exec"].into_iter().zip(&bodies) {
        client.post::<_, Value>(path, body).await.unwrap();
    }
    let requests = task.await.unwrap();
    for ((headers, sent), expected) in requests.iter().zip(bodies) {
        assert!(headers.starts_with("POST /v1/boxes"));
        assert_eq!(*sent, expected);
    }
}

#[tokio::test]
async fn all_send_paths_enforce_the_route_inventory() {
    let client = ApiClient::new(&BoxliteRestOptions::new("http://127.0.0.1:1")).unwrap();
    let mut errors = vec![
        client.get::<Value>("/undeclared").await.unwrap_err(),
        client
            .post_no_content("/undeclared", &json!({}))
            .await
            .unwrap_err(),
        client
            .post_for_bytes("/undeclared", &json!({}))
            .await
            .unwrap_err(),
        client
            .post_bytes_for_json::<Value>("/undeclared", vec![1], &[])
            .await
            .unwrap_err(),
        client.head_exists("/undeclared").await.unwrap_err(),
        client
            .send_file(
                Method::PUT,
                "/undeclared",
                Some(reqwest::Body::wrap_stream(futures::stream::pending::<
                    Result<bytes::Bytes, std::io::Error>,
                >())),
            )
            .await
            .unwrap_err(),
        client
            .send_file(Method::GET, "/undeclared", None)
            .await
            .unwrap_err(),
    ];
    errors.push(client.connect_ws("/undeclared").await.unwrap_err());
    for error in errors {
        assert!(matches!(error, BoxliteError::Internal(_)), "{error}");
    }
}

#[tokio::test]
async fn operation_rules_cover_empty_bytes_and_json_responses() {
    let (options, task) = server(vec![(200, r#"{"api_version":"0.11.0"}"#.into())]).await;
    let client = ApiClient::new(&options).unwrap();
    let errors = [
        client.delete("/boxes/id/snapshots/name").await.unwrap_err(),
        client
            .post_for_bytes("/boxes/id/export", &json!({}))
            .await
            .unwrap_err(),
        client
            .get::<Value>("/boxes/id/snapshots")
            .await
            .unwrap_err(),
        client
            .post_bytes_for_json::<Value>("/boxes/import", vec![1], &[])
            .await
            .unwrap_err(),
    ];
    for error in errors {
        assert!(matches!(error, BoxliteError::Unsupported(_)), "{error}");
    }
    assert_eq!(task.await.unwrap().len(), 1);
}

#[tokio::test]
async fn file_upload_preserves_stream_headers_query_and_bytes() {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let client = ApiClient::new(&BoxliteRestOptions::new(format!(
        "http://{}",
        listener.local_addr().unwrap()
    )))
    .unwrap();
    let server = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        let mut reader = BufReader::new(socket);
        let mut headers = String::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            headers.push_str(&line);
            if line == "\r\n" {
                break;
            }
        }
        assert!(
            headers
                .starts_with("PUT /v1/boxes/id/files?path=%2Ftmp&source_is_dir=true HTTP/1.1\r\n")
        );
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("content-type: application/x-tar\r\n")
        );
        assert!(
            headers
                .to_ascii_lowercase()
                .contains("transfer-encoding: chunked\r\n")
        );
        let mut received = Vec::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).await.unwrap();
            let length = usize::from_str_radix(line.trim(), 16).unwrap();
            if length == 0 {
                break;
            }
            let mut chunk = vec![0; length];
            reader.read_exact(&mut chunk).await.unwrap();
            received.extend(chunk);
            let mut ending = [0; 2];
            reader.read_exact(&mut ending).await.unwrap();
            assert_eq!(&ending, b"\r\n");
        }
        respond(reader.get_mut(), 204, "").await;
        received
    });
    let data = bytes::Bytes::from_static(&[0, 255, 10, 128]);
    let expected = data.clone();
    let body = reqwest::Body::wrap_stream(futures::stream::once(async move {
        Ok::<_, std::io::Error>(data)
    }));
    let response = client
        .send_file(
            Method::PUT,
            "/boxes/id/files?path=%2Ftmp&source_is_dir=true",
            Some(body),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(server.await.unwrap(), expected);
}
