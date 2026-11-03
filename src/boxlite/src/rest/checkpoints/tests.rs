use super::*;
use crate::{BoxliteRestOptions, CheckpointHandle};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn server(replies: Vec<(u16, Value)>) -> (ApiClient, tokio::task::JoinHandle<Vec<String>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let options =
        BoxliteRestOptions::new(format!("http://{}/base", listener.local_addr().unwrap()))
            .with_api_key("checkpoint-test-key")
            .with_path_prefix("team");
    let task = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (status, body) in replies {
            let (mut stream, _) =
                tokio::time::timeout(std::time::Duration::from_secs(5), listener.accept())
                    .await
                    .unwrap()
                    .unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut buffer = [0; 4096];
                let count = stream.read(&mut buffer).await.unwrap();
                assert_ne!(count, 0);
                bytes.extend_from_slice(&buffer[..count]);
                if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&bytes[..end]);
                    let length = head
                        .lines()
                        .find_map(|line| {
                            let (key, value) = line.split_once(':')?;
                            key.eq_ignore_ascii_case("content-length")
                                .then(|| value.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if bytes.len() >= end + 4 + length {
                        break;
                    }
                }
            }
            requests.push(String::from_utf8(bytes).unwrap());
            let body = if status == 204 {
                String::new()
            } else {
                body.to_string()
            };
            stream.write_all(format!("HTTP/1.1 {status} Reply\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
        }
        requests
    });
    (ApiClient::new(&options).unwrap(), task)
}
fn capabilities() -> Value {
    json!({"capabilities":{"checkpoint_management_enabled":true}})
}
fn info(status: &str) -> Value {
    json!({"id":"checkpoint-1","box_id":"source","name":"saved","created_at":1,"status":status,"error":null,"cpus":2,"memory_bytes":4096,"container_disk_bytes":8192,"size_bytes":16384})
}
fn bx(status: &str) -> Value {
    json!({"box_id":"child-1","name":"restored","status":status,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","image":"base","cpus":2,"memory_mib":1024})
}
fn body(request: &str) -> Value {
    serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap()
}

#[tokio::test]
async fn checkpoint_requests_preserve_omitted_names_and_nondefault_names_and_poll_ready() {
    let (client, task) = server(vec![
        (200, capabilities()),
        (201, info("creating")),
        (200, info("ready")),
        (201, info("ready")),
    ])
    .await;
    let handle = CheckpointHandle::new(Arc::new(RestCheckpoints::new(
        client,
        Some("source".into()),
    )));
    assert_eq!(handle.create(None).await.unwrap().status, "ready");
    handle.create(Some("before-upgrade".into())).await.unwrap();
    let requests = task.await.unwrap();
    assert!(requests[1].starts_with("POST /base/v1/team/boxes/source/checkpoints "));
    assert_eq!(body(&requests[1]), json!({}));
    assert_eq!(body(&requests[3]), json!({"name":"before-upgrade"}));
    assert!(requests[2].starts_with("GET /base/v1/team/boxes/source/checkpoints/checkpoint-1 "));
    assert!(requests.iter().all(|request| {
        request
            .to_ascii_lowercase()
            .contains("authorization: bearer checkpoint-test-key")
    }));
    assert!(
        requests[1]
            .to_ascii_lowercase()
            .contains("content-type: application/json")
    );
}

#[tokio::test]
async fn checkpoint_create_from_waits_for_paused_and_rejects_running_without_retry() {
    for name in [None, Some("new-box".to_owned())] {
        let (client, task) = server(vec![
            (200, capabilities()),
            (201, bx("configured")),
            (200, bx("paused")),
        ])
        .await;
        let backend = RestCheckpoints::new(client, None);
        assert_eq!(
            backend
                .create_from("saved", name.clone())
                .await
                .unwrap()
                .id()
                .as_str(),
            "child-1"
        );
        let requests = task.await.unwrap();
        assert!(requests[1].starts_with("POST /base/v1/team/checkpoints/saved/boxes "));
        assert_eq!(
            body(&requests[1]),
            name.map(|name| json!({"name":name}))
                .unwrap_or_else(|| json!({}))
        );
        assert!(requests[2].starts_with("GET /base/v1/team/boxes/child-1 "));
    }
    let (client, task) = server(vec![(200, capabilities()), (201, bx("running"))]).await;
    let error = RestCheckpoints::new(client, None)
        .create_from("saved", None)
        .await
        .err()
        .unwrap();
    assert!(matches!(error, BoxliteError::InvalidState(_)));
    assert!(error.to_string().contains("child-1"));
    task.await.unwrap();
}

#[tokio::test]
async fn checkpoint_catalog_root_scoped_absence_force_permissions_and_old_server() {
    let missing =
        json!({"error":{"message":"gone","code":"not_found","error_type":"NotFoundError"}});
    let forbidden = json!({"error":{"message":"denied","code":"permission_denied","error_type":"PermissionDeniedError"}});
    let (client, task) = server(vec![
        (200, capabilities()),
        (404, missing.clone()),
        (404, missing.clone()),
        (404, missing),
        (403, forbidden),
    ])
    .await;
    let root = RestCheckpoints::new(client.clone(), None);
    let scoped = RestCheckpoints::new(client, Some("source".into()));
    assert!(matches!(
        root.get("gone").await,
        Err(BoxliteError::NotFound(_))
    ));
    assert!(scoped.get("gone").await.unwrap().is_none());
    root.remove("gone", true).await.unwrap();
    assert!(root.remove("gone", true).await.is_err());
    task.await.unwrap();
    let (client, task) = server(vec![(200, json!({"capabilities":{}}))]).await;
    assert!(matches!(
        RestCheckpoints::new(client, None).list().await,
        Err(BoxliteError::Unsupported(_))
    ));
    assert_eq!(task.await.unwrap().len(), 1);
}

#[tokio::test]
async fn checkpoint_memory_submission_does_not_follow_redirect_or_retry_response_loss() {
    for redirect in [true, false] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = ApiClient::new(&BoxliteRestOptions::new(format!(
            "http://{}",
            listener.local_addr().unwrap()
        )))
        .unwrap();
        let task = tokio::spawn(async move {
            for index in 0..2 {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    request.push(stream.read_u8().await.unwrap());
                }
                let header = String::from_utf8(request).unwrap();
                let length = header
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().unwrap())
                    })
                    .unwrap_or(0);
                let mut body = vec![0; length];
                stream.read_exact(&mut body).await.unwrap();
                if index == 0 {
                    assert!(header.starts_with("GET /v1/config "));
                    let body = capabilities().to_string();
                    stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
                } else {
                    assert!(header.starts_with("POST /v1/checkpoints/saved/boxes "));
                    if redirect {
                        stream.write_all(b"HTTP/1.1 307 Temporary Redirect\r\nLocation: /v1/must-not-follow\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await.unwrap();
                    }
                }
            }
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(150), listener.accept())
                    .await
                    .is_err(),
                "memory operation was replayed"
            );
        });
        assert!(
            RestCheckpoints::new(client, None)
                .create_from("saved", None)
                .await
                .is_err()
        );
        task.await.unwrap();
    }
}
