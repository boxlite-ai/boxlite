use super::*;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;

const BOX_RESPONSE: &str = r#"{"box_id":"cpu-limited","status":"configured","created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","image":"alpine","cpus":2,"memory_mib":512,"cpu_limit":0.125}"#;
// Captured from main's serve JSON extractor, Cloud DTO/filter, and reference ASGI validator.
const SERVE_REFUSAL: &str = "Failed to deserialize the JSON body into the target type: cpu_limit: unknown field `cpu_limit`, expected one of `name`, `image`, `rootfs_path`, `cpus`, `memory_mib`, `disk_size_gb`, `working_dir`, `env`, `entrypoint`, `cmd`, `user`, `tty`, `advanced`, `network`, `auto_stop`, `auto_delete`, `auto_resume`, `detach`, `secrets`, `volumes` at line 1 column 42";
const CLOUD_REFUSAL: &str =
    r#"{"statusCode":400,"error":"Bad Request","message":"property cpu_limit should not exist"}"#;
const REFERENCE_REFUSAL: &str = r#"{"detail":[{"type":"extra_forbidden","loc":["body","cpu_limit"],"msg":"Extra inputs are not permitted","input":0.125}]}"#;

// Keep listening until the production operation finishes, so retries and config
// probes remain observable instead of failing against an already closed socket.
async fn create_response(
    status: u16,
    body: &'static str,
    limit: Option<crate::CpuLimit>,
    get_or_create: bool,
) -> (BoxliteResult<LiteBox>, Vec<(String, Value)>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let (stop, mut stopped) = oneshot::channel();
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
                (404, r#"{"error":{"code":"not_found","message":"missing"}}"#)
            } else {
                (status, body)
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
        cpus: Some(2),
        cpu_limit: limit,
        ..Default::default()
    };
    let result = tokio::time::timeout(std::time::Duration::from_secs(5), async {
        if get_or_create {
            RuntimeBackend::get_or_create(&runtime, options, Some("named".into()))
                .await
                .map(|(b, created)| {
                    assert!(created);
                    b
                })
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

fn limit() -> Option<crate::CpuLimit> {
    Some(crate::CpuLimit::new(0.125).unwrap())
}

#[tokio::test]
async fn cpu_limit_create_posts_without_config_and_preserves_request() {
    for requested in [None, limit()] {
        let (result, requests) = create_response(201, BOX_RESPONSE, requested, false).await;
        assert!(result.is_ok(), "{:?}", result.as_ref().err());
        assert_eq!(requests.len(), 1, "{requests:?}");
        assert_eq!(requests[0].0, "POST /v1/boxes HTTP/1.1");
        assert_eq!(requests[0].1["cpus"], 2);
        assert!(requests[0].1.get("cpu_limit_millicpu").is_none());
        if requested.is_some() {
            assert_eq!(requests[0].1["cpu_limit"], 0.125);
        } else {
            assert!(requests[0].1.get("cpu_limit").is_none());
        }
    }
}

#[tokio::test]
async fn cpu_limit_unknown_field_reports_field_and_reason_without_retry() {
    for (status, body, reason) in [
        (422, SERVE_REFUSAL, "unknown field `cpu_limit`"),
        (400, CLOUD_REFUSAL, "property cpu_limit should not exist"),
        (422, REFERENCE_REFUSAL, "Extra inputs are not permitted"),
        (
            400,
            r#"{"error":{"code":"invalid_argument","message":"unknown field `cpu_limit`, expected `image`"}}"#,
            "unknown field `cpu_limit`",
        ),
        (
            400,
            r#"{"message":"cpus must be positive, property cpu_limit should not exist"}"#,
            "property cpu_limit should not exist",
        ),
    ] {
        let (result, requests) = create_response(status, body, limit(), false).await;
        let error = result.err().expect("server must reject create");
        assert!(matches!(error, BoxliteError::Unsupported(_)), "{error:?}");
        let message = error.to_string();
        assert!(
            message.contains("cpu_limit") && message.contains(reason),
            "{message}"
        );
        assert!(
            !message.contains("\"input\"") && !message.contains("0.125"),
            "{message}"
        );
        assert_eq!(requests.len(), 1, "{requests:?}");
        assert_eq!(requests[0].0, "POST /v1/boxes HTTP/1.1");
    }
}

#[tokio::test]
async fn cpu_limit_other_refusals_keep_original_error_mapping() {
    for (status, body) in [
        (
            400,
            "unknown field `other`, expected `image` or `cpu_limit`",
        ),
        (
            422,
            "Failed to deserialize the JSON body into the target type: advanced.cpu_limit: unknown field `cpu_limit`, expected `privileged`",
        ),
        (400, "unknown field `cpu_limit_extra`, expected `image`"),
        (
            400,
            r#"{"message":"property advanced.cpu_limit should not exist"}"#,
        ),
        (
            400,
            r#"{"message":"property cpu_limit_extra should not exist"}"#,
        ),
        (
            422,
            r#"{"detail":[{"type":"extra_forbidden","loc":["body","advanced","cpu_limit"],"msg":"Extra inputs are not permitted"}]}"#,
        ),
        (
            422,
            r#"{"detail":[{"type":"less_than_equal","loc":["body","cpu_limit"],"msg":"must not exceed cpus"}]}"#,
        ),
        (
            400,
            r#"{"error":{"code":"invalid_argument","message":"cpu_limit must not exceed cpus"}}"#,
        ),
        (
            400,
            r#"{"error":{"code":"future_code","message":"unknown field `cpu_limit`, expected `image`"}}"#,
        ),
        (
            400,
            r#"{"code":"future_code","message":"property cpu_limit should not exist"}"#,
        ),
        (
            422,
            r#"{"code":"image_pull_failed","message":"unknown field `cpu_limit`, expected `image`"}"#,
        ),
        (
            400,
            r#"{"error":{"code":"unsupported","message":"CPU controller is not delegated for cpu_limit"}}"#,
        ),
        (401, CLOUD_REFUSAL),
        (403, CLOUD_REFUSAL),
        (429, CLOUD_REFUSAL),
        (500, CLOUD_REFUSAL),
        (502, ""),
    ] {
        let expected = super::super::error::map_http_body(
            reqwest::StatusCode::from_u16(status).unwrap(),
            body,
        );
        let (result, requests) = create_response(status, body, limit(), false).await;
        let error = result.err().expect("server must reject create");
        assert_eq!(
            std::mem::discriminant(&error),
            std::mem::discriminant(&expected),
            "{body}: {error:?}"
        );
        assert_eq!(error.to_string(), expected.to_string());
        assert_eq!(requests.len(), 1, "{requests:?}");
        assert_eq!(requests[0].0, "POST /v1/boxes HTTP/1.1");
    }
    let (result, requests) = create_response(400, CLOUD_REFUSAL, None, false).await;
    assert!(matches!(result, Err(BoxliteError::InvalidArgument(_))));
    assert_eq!(requests.len(), 1);
}

#[tokio::test]
async fn cpu_limit_get_or_create_missing_posts_without_config() {
    let (result, requests) = create_response(201, BOX_RESPONSE, limit(), true).await;
    assert!(result.is_ok(), "{:?}", result.as_ref().err());
    assert_eq!(
        requests.iter().map(|r| r.0.as_str()).collect::<Vec<_>>(),
        ["GET /v1/boxes/named HTTP/1.1", "POST /v1/boxes HTTP/1.1"]
    );
    assert_eq!(requests[1].1["cpu_limit"], 0.125);
}
