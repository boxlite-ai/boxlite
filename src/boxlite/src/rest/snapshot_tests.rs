use crate::{BoxOptions, BoxliteError, BoxliteRestOptions, BoxliteRuntime, RootfsSpec};
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

async fn server(
    replies: Vec<(u16, Value)>,
) -> (BoxliteRuntime, tokio::task::JoinHandle<Vec<String>>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        let mut requests = Vec::new();
        for (status, reply) in replies {
            let (mut stream, _) =
                tokio::time::timeout(std::time::Duration::from_secs(5), listener.accept())
                    .await
                    .unwrap()
                    .unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut chunk = [0; 4096];
                let read = stream.read(&mut chunk).await.unwrap();
                assert_ne!(read, 0);
                bytes.extend_from_slice(&chunk[..read]);
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
                reply.to_string()
            };
            let response = format!(
                "HTTP/1.1 {status} Reply\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        }
        requests
    });
    let mut options = BoxliteRestOptions::new(format!("http://{address}"));
    options.path_prefix = Some("acme".into());
    (BoxliteRuntime::rest(options).unwrap(), task)
}

fn capabilities() -> Value {
    json!({"capabilities":{"snapshots_enabled":true,"create_from_snapshot_enabled":true}})
}
fn snapshot() -> Value {
    json!({"id":"snapshot-1","box_id":"deleted-source","name":"saved","created_at":1,"container_disk_bytes":1024,"size_bytes":256,"status":"failed","error":"export interrupted"})
}
fn bx(status: &str) -> Value {
    json!({"box_id":"child-1","name":"cozy-otter","status":status,"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","image":"base","cpus":2,"memory_mib":1024})
}

#[tokio::test]
async fn snapshot_catalog_survives_source_deletion_and_preserves_status() {
    let (runtime, task) = server(vec![
        (200, capabilities()),
        (200, json!({"snapshots":[snapshot()]})),
        (200, snapshot()),
    ])
    .await;
    let catalog = runtime.snapshots().unwrap();
    let infos = catalog.list().await.unwrap();
    assert_eq!(infos[0].box_id, "deleted-source");
    assert_eq!(infos[0].status, "failed");
    assert_eq!(infos[0].error.as_deref(), Some("export interrupted"));
    assert_eq!(catalog.get("a/b").await.unwrap().id, "snapshot-1");
    let requests = task.await.unwrap();
    assert!(requests[1].starts_with("GET /v1/acme/snapshots "));
    assert!(requests[2].starts_with("GET /v1/acme/snapshots/a%2Fb "));
    assert!(requests.iter().all(|r| !r.contains("/boxes/")));
}

#[tokio::test]
async fn snapshot_catalog_force_only_ignores_not_found() {
    let absent =
        json!({"error":{"message":"gone","code":"not_found","error_type":"NotFoundError"}});
    let forbidden = json!({"error":{"message":"denied","code":"permission_denied","error_type":"PermissionDeniedError"}});
    let (runtime, task) = server(vec![
        (200, capabilities()),
        (404, absent.clone()),
        (404, absent.clone()),
        (404, absent),
        (403, forbidden),
    ])
    .await;
    let catalog = runtime.snapshots().unwrap();
    assert!(matches!(
        catalog.get("missing").await,
        Err(BoxliteError::NotFound(_))
    ));
    assert!(matches!(
        catalog.remove("missing", false).await,
        Err(BoxliteError::NotFound(_))
    ));
    catalog.remove("missing", true).await.unwrap();
    assert!(catalog.remove("protected", true).await.is_err());
    assert_eq!(task.await.unwrap().len(), 5);
}

#[tokio::test]
async fn snapshot_creation_waits_for_the_new_identity_without_replaying_post() {
    let (runtime, task) = server(vec![
        (200, capabilities()),
        (201, bx("configured")),
        (200, bx("configured")),
        (200, bx("running")),
    ])
    .await;
    let options = BoxOptions {
        cpus: Some(2),
        memory_mib: Some(1024),
        ..Default::default()
    };
    let child = runtime
        .create_from_snapshot("saved", options, None)
        .await
        .unwrap();
    assert_eq!(child.id().as_str(), "child-1");
    assert_eq!(child.name(), Some("cozy-otter"));
    let requests = task.await.unwrap();
    assert!(requests[1].starts_with("POST /v1/acme/snapshots/saved/boxes "));
    let body: Value = serde_json::from_str(requests[1].split_once("\r\n\r\n").unwrap().1).unwrap();
    assert_eq!(body["options"]["cpus"], 2);
    assert!(body.get("name").is_none());
    assert!(body["options"].get("image").is_none());
    assert!(body["options"].get("rootfs_path").is_none());
    assert_eq!(
        requests.iter().filter(|r| r.starts_with("POST ")).count(),
        1
    );
    assert!(requests[3].starts_with("GET /v1/acme/boxes/child-1 "));
}

#[tokio::test]
async fn snapshot_creation_reports_terminal_startup_failure() {
    // The cloud maps its error state to unknown; other servers can report failed.
    for status in ["unknown", "failed", "stopped"] {
        let (runtime, task) = server(vec![
            (200, capabilities()),
            (201, bx("configured")),
            (200, bx(status)),
        ])
        .await;
        let error = runtime
            .create_from_snapshot("saved", BoxOptions::default(), None)
            .await
            .err()
            .unwrap();
        assert!(error.to_string().contains("child-1"));
        assert!(error.to_string().contains(status));
        assert_eq!(task.await.unwrap().len(), 3);
    }
}

#[tokio::test]
async fn snapshot_creation_requires_explicit_capability() {
    for caps in [
        json!({"snapshots_enabled":true}),
        json!({"create_from_snapshot_enabled":false}),
    ] {
        let (runtime, task) = server(vec![(200, json!({"capabilities":caps}))]).await;
        assert!(matches!(
            runtime
                .create_from_snapshot("saved", BoxOptions::default(), None)
                .await,
            Err(BoxliteError::Unsupported(_))
        ));
        assert_eq!(task.await.unwrap().len(), 1);
    }
}

#[tokio::test]
async fn snapshot_creation_rejects_ambiguous_sources_before_network_io() {
    let runtime = BoxliteRuntime::rest(BoxliteRestOptions::new("http://127.0.0.1:1")).unwrap();
    for rootfs in [
        RootfsSpec::RootfsPath("/tmp/rootfs".into()),
        RootfsSpec::Image("ubuntu:latest".into()),
    ] {
        assert!(matches!(
            runtime
                .create_from_snapshot(
                    "saved",
                    BoxOptions {
                        rootfs,
                        ..Default::default()
                    },
                    None
                )
                .await,
            Err(BoxliteError::InvalidArgument(_))
        ));
    }
    assert!(matches!(
        runtime.snapshots().unwrap().get("..").await,
        Err(BoxliteError::InvalidArgument(_))
    ));
}

#[tokio::test]
async fn snapshot_metadata_from_a_legacy_server_defaults_to_ready() {
    let mut info = snapshot();
    info.as_object_mut().unwrap().remove("status");
    info.as_object_mut().unwrap().remove("error");
    let (runtime, task) = server(vec![(200, capabilities()), (200, info)]).await;
    let info = runtime.snapshots().unwrap().get("saved").await.unwrap();
    assert_eq!(info.status, "ready");
    assert!(info.error.is_none());
    task.await.unwrap();
}
