//! New REST contract: exercise the production runtime over real loopback HTTP.
use super::*;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

fn options(enabled: bool) -> BoxOptions {
    let mut options = BoxOptions {
        rootfs: crate::RootfsSpec::Image("alpine:latest".into()),
        ..Default::default()
    };
    options.advanced.nested_virtualization = enabled;
    options
}

fn box_response(nested: Option<bool>) -> Value {
    let mut response = json!({
        "box_id":"nested-box", "name":"named", "status":"configured",
        "created_at":"2026-01-01T00:00:00Z", "updated_at":"2026-01-01T00:00:00Z",
        "pid":null, "image":"alpine:latest", "cpus":1, "memory_mib":512
    });
    if let Some(nested) = nested {
        response["advanced"] = json!({"nested_virtualization":nested});
    }
    response
}

async fn server(
    responses: Vec<(u16, Value)>,
) -> (RestRuntime, tokio::task::JoinHandle<Vec<(String, Value)>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let runtime = RestRuntime::new(&BoxliteRestOptions::new(format!(
        "http://{}",
        listener.local_addr().unwrap()
    )))
    .unwrap();
    let task = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (status, response) in responses {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                head.push(socket.read_u8().await.unwrap());
            }
            let head = String::from_utf8(head).unwrap();
            let length = head
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .unwrap_or(0);
            let mut body = vec![0; length];
            socket.read_exact(&mut body).await.unwrap();
            requests.push((
                head,
                if body.is_empty() {
                    Value::Null
                } else {
                    serde_json::from_slice(&body).unwrap()
                },
            ));
            let body = response.to_string();
            socket.write_all(format!(
                "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()
            ).as_bytes()).await.unwrap();
        }
        requests
    });
    (runtime, task)
}

#[tokio::test]
async fn nested_virtualization_default_request_preserves_old_wire_shape() {
    for explicit in [None, Some(false)] {
        let (runtime, task) = server(vec![(201, box_response(None))]).await;
        let mut requested = BoxOptions {
            rootfs: crate::RootfsSpec::Image("alpine:latest".into()),
            ..Default::default()
        };
        if let Some(enabled) = explicit {
            requested.advanced.nested_virtualization = enabled;
        }
        RuntimeBackend::create(&runtime, requested, None)
            .await
            .unwrap();
        let requests = task.await.unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].0.starts_with("POST /v1/boxes HTTP/1.1\r\n"));
        assert!(
            requests[0]
                .0
                .to_lowercase()
                .contains("content-type: application/json")
        );
        assert_eq!(
            requests[0].1,
            json!({
                "image":"alpine:latest", "network":{"mode":"enabled"}, "detach":false
            })
        );
    }
}

#[tokio::test]
async fn nested_virtualization_create_preserves_explicit_empty_capability_policy() {
    let config = json!({"capabilities":{
        "nested_virtualization_enabled":true, "linux_capabilities_enabled":true
    }});
    let (runtime, task) = server(vec![
        (200, config.clone()),
        (200, config),
        (201, box_response(Some(true))),
    ])
    .await;
    let mut options = options(true);
    options
        .advanced
        .set_capabilities(Some(Default::default()))
        .unwrap();
    RuntimeBackend::create(&runtime, options, None)
        .await
        .unwrap();
    let requests = task.await.unwrap();
    assert_eq!(requests.len(), 3);
    assert!(requests[0].0.starts_with("GET /v1/config HTTP/1.1\r\n"));
    assert!(requests[1].0.starts_with("GET /v1/config HTTP/1.1\r\n"));
    assert_eq!(
        requests[2].1["advanced"],
        json!({
            "nested_virtualization":true, "capabilities":{"add":[], "drop":[]}
        })
    );
    assert!(requests[2].1["advanced"].get("security").is_none());
}

#[tokio::test]
async fn nested_virtualization_requires_fresh_valid_capability_without_creating() {
    for config in [
        json!({}),
        json!({"capabilities":{}}),
        json!({"capabilities":{"nested_virtualization_enabled":false}}),
        json!({"capabilities":{"nested_virtualization_enabled":null}}),
        json!({"capabilities":{"nested_virtualization_enabled":"true"}}),
    ] {
        let malformed = config["capabilities"]
            .get("nested_virtualization_enabled")
            .is_some_and(|value| !value.is_boolean());
        let (runtime, task) = server(vec![(200, config)]).await;
        let error = RuntimeBackend::create(&runtime, options(true), None)
            .await
            .err()
            .unwrap();
        assert_eq!(
            matches!(error, BoxliteError::Unsupported(_)),
            !malformed,
            "{error}"
        );
        let requests = task.await.unwrap();
        assert_eq!(requests.len(), 1);
        assert!(requests[0].0.starts_with("GET /v1/config HTTP/1.1\r\n"));
    }
    let (runtime, task) = server(vec![
        (
            200,
            json!({"capabilities":{"nested_virtualization_enabled":true}}),
        ),
        (201, box_response(Some(true))),
        (200, json!({"capabilities":{}})),
    ])
    .await;
    RuntimeBackend::create(&runtime, options(true), None)
        .await
        .unwrap();
    assert!(matches!(
        RuntimeBackend::create(&runtime, options(true), None).await,
        Err(BoxliteError::Unsupported(_))
    ));
    assert_eq!(task.await.unwrap().len(), 3);
}

#[tokio::test]
async fn nested_virtualization_create_requires_persisted_confirmation() {
    for stored in [None, Some(false)] {
        let (runtime, task) = server(vec![
            (
                200,
                json!({"capabilities":{"nested_virtualization_enabled":true}}),
            ),
            (201, box_response(stored)),
        ])
        .await;
        let error = RuntimeBackend::create(&runtime, options(true), None)
            .await
            .err()
            .unwrap();
        assert!(matches!(error, BoxliteError::InvalidState(_)), "{error}");
        assert!(error.to_string().contains("nested-box"));
        assert_eq!(task.await.unwrap().len(), 2, "no retry, start or cleanup");
    }
}

#[tokio::test]
async fn nested_virtualization_get_or_create_checks_saved_requirement() {
    for requested in [false, true] {
        for stored in [None, Some(false), Some(true)] {
            let (runtime, task) = server(vec![(200, box_response(stored))]).await;
            let result =
                RuntimeBackend::get_or_create(&runtime, options(requested), Some("named".into()))
                    .await;
            if requested && stored != Some(true) {
                assert!(matches!(result, Err(BoxliteError::InvalidState(_))));
            } else {
                assert!(!result.unwrap().1);
            }
            let requests = task.await.unwrap();
            assert_eq!(requests.len(), 1);
            assert!(
                requests[0]
                    .0
                    .starts_with("GET /v1/boxes/named HTTP/1.1\r\n")
            );
        }
    }
}

#[tokio::test]
async fn nested_virtualization_metadata_get_and_list_preserve_unknown() {
    for stored in [None, Some(false), Some(true)] {
        let response = box_response(stored);
        let (runtime, task) = server(vec![
            (200, response.clone()),
            (200, json!({"boxes":[response]})),
        ])
        .await;
        let info = RuntimeBackend::get_info(&runtime, "nested-box")
            .await
            .unwrap()
            .unwrap();
        let list = RuntimeBackend::list_info(&runtime).await.unwrap();
        for info in [info, list.into_iter().next().unwrap()] {
            assert_eq!(
                info.advanced
                    .and_then(|advanced| advanced.nested_virtualization),
                stored
            );
        }
        assert_eq!(task.await.unwrap().len(), 2);
    }
}

#[tokio::test]
async fn nested_virtualization_config_preserves_authentication_errors() {
    for status in [401, 403, 500] {
        let (runtime, task) = server(vec![(status, json!({"message":"denied"}))]).await;
        let error = RuntimeBackend::create(&runtime, options(true), None)
            .await
            .err()
            .unwrap();
        assert!(!matches!(error, BoxliteError::Unsupported(_)), "{error}");
        assert_eq!(task.await.unwrap().len(), 1);
    }
}

#[tokio::test]
async fn nested_virtualization_local_authorization_and_metadata_survive_reopen() {
    use crate::experimental::{ExperimentalFeatures, RuntimeBuilder};

    let home = tempfile::tempdir().unwrap();
    let config = crate::BoxliteOptions {
        home_dir: home.path().to_owned(),
        ..Default::default()
    };
    let runtime = RuntimeBuilder::new(config.clone())
        .build_for_test()
        .unwrap();
    let error = runtime
        .create(options(true), Some("denied".into()))
        .await
        .err()
        .unwrap();
    assert!(matches!(error, BoxliteError::Config(_)), "{error}");
    assert!(
        error
            .to_string()
            .contains("nested virtualization support is an RC feature and is disabled")
    );
    assert!(runtime.list_info().await.unwrap().is_empty());
    runtime.shutdown(None).await.unwrap();
    drop(runtime);

    let runtime = RuntimeBuilder::new(config.clone())
        .with_features(ExperimentalFeatures::parse("nested-virtualization").unwrap())
        .build_for_test()
        .unwrap();
    for requested in [false, true] {
        let name = if requested { "nested" } else { "ordinary" };
        let mut options = options(requested);
        options.detach = true;
        options.auto_delete = Some(0);
        let sandbox = runtime.create(options, Some(name.into())).await.unwrap();
        assert_eq!(
            sandbox
                .info()
                .await
                .unwrap()
                .advanced
                .unwrap()
                .nested_virtualization,
            Some(requested)
        );
    }
    runtime.shutdown(None).await.unwrap();
    drop(runtime);

    let runtime = RuntimeBuilder::new(config).build_for_test().unwrap();
    for (name, requested) in [("ordinary", false), ("nested", true)] {
        let saved = runtime.get_info(name).await.unwrap().unwrap();
        assert_eq!(
            saved.advanced.unwrap().nested_virtualization,
            Some(requested)
        );
    }
    runtime.shutdown(None).await.unwrap();
}

#[tokio::test]
async fn nested_virtualization_concurrent_create_never_reuses_an_incompatible_winner() {
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::Barrier;

    for stored in [None, Some(false), Some(true)] {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let runtime = RestRuntime::new(&BoxliteRestOptions::new(format!(
                "http://{}", listener.local_addr().unwrap()
            ))).unwrap();
            let barrier = Arc::new(Barrier::new(2));
            let created = Arc::new(AtomicBool::new(false));
            let task = tokio::spawn(async move {
                let mut connections = tokio::task::JoinSet::new();
                for _ in 0..6 {
                    let (mut socket, _) = listener.accept().await.unwrap();
                    let barrier = barrier.clone();
                    let created = created.clone();
                    connections.spawn(async move {
                        let mut bytes = Vec::new();
                        while !bytes.ends_with(b"\r\n\r\n") {
                            bytes.push(socket.read_u8().await.unwrap());
                        }
                        let head = String::from_utf8(bytes).unwrap();
                        let line = head.lines().next().unwrap().to_owned();
                        let length = head.lines().find_map(|line| {
                            let (name, value) = line.split_once(':')?;
                            name.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        }).unwrap_or(0);
                        let mut body = vec![0; length];
                        socket.read_exact(&mut body).await.unwrap();
                        let (status, response) = if line.starts_with("GET /v1/boxes/named ") {
                            barrier.wait().await;
                            (404, json!({"message":"not found"}))
                        } else if line.starts_with("GET /v1/config ") {
                            (200, json!({"capabilities":{"nested_virtualization_enabled":true}}))
                        } else {
                            assert!(line.starts_with("POST /v1/boxes "), "{line}");
                            let sent: Value = serde_json::from_slice(&body).unwrap();
                            assert_eq!(sent["advanced"]["nested_virtualization"], true);
                            if created.swap(true, Ordering::SeqCst) {
                                (409, json!({"code":"already_exists", "message":"name held"}))
                            } else {
                                (201, box_response(stored))
                            }
                        };
                        let body = response.to_string();
                        socket.write_all(format!(
                            "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()
                        ).as_bytes()).await.unwrap();
                        line
                    });
                }
                let mut lines = Vec::new();
                while let Some(result) = connections.join_next().await {
                    lines.push(result.unwrap());
                }
                lines
            });
            let (first, second) = tokio::join!(
                RuntimeBackend::get_or_create(&runtime, options(true), Some("named".into())),
                RuntimeBackend::get_or_create(&runtime, options(true), Some("named".into()))
            );
            let requests = task.await.unwrap();
            let mut successes = 0;
            for result in [first, second] {
                match result {
                    Ok((_, created)) => { assert!(created); successes += 1; }
                    Err(error) => assert!(matches!(error,
                        BoxliteError::AlreadyExists(_) | BoxliteError::InvalidState(_)), "{error}; {requests:?}"),
                }
            }
            assert_eq!(successes, usize::from(stored == Some(true)));
            assert_eq!(requests.len(), 6);
        }).await.expect("controlled create race must finish");
    }
}
