use super::*;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

const BOX_RESPONSE: &str = r#"{"box_id":"fractional-box","status":"configured","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","image":"alpine","cpus":0.125,"memory_mib":512}"#;

// Keep listening until the production operation finishes, so retries and config
// probes remain observable instead of failing against an already closed socket.
async fn create_response(
    status: u16,
    body: &str,
    cpus: Option<f64>,
    lookup_response: Option<&str>,
) -> (BoxliteResult<LiteBox>, Vec<(String, Value)>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (stop, mut stopped) = oneshot::channel();
    let expect_created = lookup_response.is_none_or(str::is_empty);
    let saved_cpus = lookup_response.filter(|body| !body.is_empty()).map(|body| {
        serde_json::from_str::<Value>(body).unwrap()["cpus"]
            .as_f64()
            .unwrap()
    });
    let lookup_response = lookup_response.map(str::to_owned);
    let lookup = lookup_response.is_some();
    let body = body.to_owned();
    let server = tokio::spawn(async move {
        let mut requests = Vec::new();
        loop {
            let (mut socket, _) = tokio::select! {
                accepted = listener.accept() => accepted.unwrap(),
                _ = &mut stopped => break,
            };
            let mut headers = Vec::new();
            while !headers.ends_with(b"\r\n\r\n") {
                headers.push(socket.read_u8().await.unwrap());
            }
            let headers = String::from_utf8(headers).unwrap();
            let line = headers.lines().next().unwrap().to_string();
            let length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            let mut request_body = vec![0; length];
            socket.read_exact(&mut request_body).await.unwrap();
            let request_body = if request_body.is_empty() {
                Value::Null
            } else {
                assert!(
                    headers
                        .to_ascii_lowercase()
                        .contains("content-type: application/json")
                );
                serde_json::from_slice(&request_body).unwrap()
            };
            let (status, body) = if line.starts_with("GET /v1/boxes/") {
                match lookup_response.as_deref().filter(|body| !body.is_empty()) {
                    Some(body) => (200, body),
                    None => (404, r#"{"error":{"code":"not_found","message":"missing"}}"#),
                }
            } else {
                (status, body.as_str())
            };
            requests.push((line, request_body));
            socket.write_all(format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()
            ).as_bytes()).await.unwrap();
        }
        requests
    });
    let runtime =
        RestRuntime::new(&BoxliteRestOptions::new(format!("http://127.0.0.1:{port}"))).unwrap();
    let options = BoxOptions {
        cpus,
        ..Default::default()
    };
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        if lookup {
            let (b, created) =
                RuntimeBackend::get_or_create(&runtime, options, Some("named".into())).await?;
            assert_eq!(created, expect_created);
            if let Some(cpus) = saved_cpus {
                assert_eq!(b.info().await?.cpus, cpus);
            }
            Ok(b)
        } else {
            RuntimeBackend::create(&runtime, options, None).await
        }
    })
    .await;
    stop.send(()).unwrap();
    let requests = server.await.unwrap();
    (
        result.expect("create must finish without retries"),
        requests,
    )
}

#[tokio::test]
async fn fractional_cpus_posts_once_and_preserves_wire_numbers() {
    for cpus in [None, Some(2.0), Some(0.125), Some(1.5)] {
        let body = BOX_RESPONSE.replace("0.125", &cpus.unwrap_or(1.0).to_string());
        let (result, requests) = create_response(201, &body, cpus, None).await;
        assert!(result.is_ok(), "{:?}", result.as_ref().err());
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].0, "POST /v1/boxes HTTP/1.1");
        let request = &requests[0].1;
        assert!(request.get("cpu_limit").is_none());
        match cpus {
            None => assert!(request.get("cpus").is_none()),
            Some(cores) => assert_eq!(request["cpus"].as_f64(), Some(cores)),
        }
        if cpus == Some(2.0) {
            assert!(request["cpus"].is_u64());
        }
        assert_eq!(result.unwrap().id().as_str(), "fractional-box");
    }
}

#[tokio::test]
async fn fractional_cpus_refuses_lost_allocation_and_identifies_created_box() {
    for body in [
        BOX_RESPONSE.replace("0.125", "1"),
        BOX_RESPONSE.replace("\"cpus\":0.125,", ""),
        BOX_RESPONSE.replace("0.125", "null"),
    ] {
        let (result, requests) = create_response(201, &body, Some(0.125), None).await;
        let error = result
            .err()
            .expect("must reject a missing or changed allocation");
        assert!(matches!(error, BoxliteError::Unsupported(_)));
        assert!(error.to_string().contains("fractional-box"));
        assert!(error.to_string().contains("cpus"));
        assert_eq!(requests.len(), 1);
    }
}

#[tokio::test]
async fn fractional_cpus_refusal_preserves_classification_without_retry() {
    let (result, requests) = create_response(
        400,
        r#"{"error":{"code":"invalid_argument","message":"cpus must be an integer"}}"#,
        Some(0.125),
        None,
    )
    .await;
    assert!(matches!(result, Err(BoxliteError::InvalidArgument(_))));
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].1["cpus"], 0.125);
}

#[tokio::test]
async fn fractional_cpus_get_or_create_posts_after_missing_name() {
    let (result, requests) = create_response(201, BOX_RESPONSE, Some(0.125), Some("")).await;
    assert!(result.is_ok());
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0].0, "GET /v1/boxes/named HTTP/1.1");
    assert_eq!(requests[1].0, "POST /v1/boxes HTTP/1.1");
    assert_eq!(requests[1].1["cpus"], 0.125);
}

#[tokio::test]
async fn fractional_cpus_named_reuse_preserves_saved_allocation() {
    for saved_cpus in [2.0, 0.5] {
        let existing = BOX_RESPONSE
            .replace("0.125", &saved_cpus.to_string())
            .replace("\"status\":", "\"privileged\":false,\"status\":");
        for cpus in [Some(1.0), Some(2.0), Some(0.5), Some(1.5), None] {
            let (result, requests) =
                create_response(201, BOX_RESPONSE, cpus, Some(&existing)).await;
            assert_eq!(result.unwrap().id().as_str(), "fractional-box");
            // The first GET reuses the Box; the second explicitly reads its info.
            assert_eq!(requests.len(), 2);
            assert_eq!(requests[0].0, "GET /v1/boxes/named HTTP/1.1");
            assert_eq!(requests[1].0, "GET /v1/boxes/fractional-box HTTP/1.1");
        }
    }
}
