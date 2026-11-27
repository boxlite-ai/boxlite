use std::time::Duration;

use super::*;
use crate::{MountRequest, MountState};
use serde_json::{Value, json};

#[test]
fn mount_state_keeps_pr3_storage_and_public_json_compatible() {
    for (stored, public) in [
        ("Mounted", "mounted"),
        ("Preparing", "preparing"),
        ("Detaching", "detaching"),
        ("Configured", "configured"),
    ] {
        let state: MountState = serde_json::from_value(json!(stored)).unwrap();
        let body =
            json!({"source": "/srv/data", "target": "/work", "read_only": true, "state": public});
        let info: crate::MountInfo = serde_json::from_value(body.clone()).unwrap();
        assert_eq!(info.state, state);
        assert_eq!(serde_json::to_value(&info).unwrap(), body);
        assert_eq!(serde_json::to_value(state).unwrap(), stored);
        assert_eq!(state.to_string(), public);
    }
    let request: MountRequest = serde_json::from_value(json!({
        "source": "/srv/data", "target": "/work",
    }))
    .unwrap();
    assert!(!request.read_only);
}

#[tokio::test]
async fn rest_runtime_mounts_preserve_paths_and_three_distinct_outcomes() {
    let config = r#"{"capabilities":{"runtime_mounts_enabled":true}}"#;
    let mounted =
        r#"{"source":"/host/data","target":"/mount a&b","read_only":true,"state":"mounted"}"#;
    let list = r#"{"mounts":[{"source":"/host/data","target":"/mount a&b","read_only":true,"state":"mounted"}]}"#;
    let collection = "/v1/boxes/01HJK4TNRPQSXYZ8WM6NCVT9R5/mounts";
    let detail = format!("{collection}/by-target?target=%2Fmount+a%26b");
    let operations = [
        ("POST", collection, 201, mounted),
        ("GET", collection, 200, list),
        ("GET", &detail, 200, mounted),
        ("DELETE", &detail, 204, ""),
        ("GET", &detail, 200, "null"),
        (
            "GET",
            &detail,
            404,
            r#"{"error":{"code":"not_found","message":"box missing"}}"#,
        ),
    ];
    let mut replies = vec![(200, BOX_RESPONSE)];
    for (_, _, status, body) in operations {
        replies.extend([(200, config), (status, body)]);
    }
    replies.push((404, ""));
    let (port, server) = exchange_server(replies).await;
    let runtime =
        RestRuntime::new(&BoxliteRestOptions::new(format!("http://127.0.0.1:{port}"))).unwrap();
    let target = "/mount a&b";
    let requests = tokio::time::timeout(Duration::from_secs(10), async {
        let mounts = runtime.get("named").await.unwrap().unwrap().mount();
        let request = MountRequest {
            source: "/host/data".into(),
            target: target.into(),
            read_only: true,
        };
        let added = mounts.add(request).await.unwrap();
        assert_eq!(added.state, MountState::Mounted);
        assert_eq!(
            mounts.list().await.unwrap().as_slice(),
            std::slice::from_ref(&added)
        );
        assert_eq!(mounts.get(target).await.unwrap(), Some(added));
        mounts.remove(target).await.unwrap();
        assert_eq!(mounts.get(target).await.unwrap(), None);
        assert!(matches!(
            mounts.get(target).await,
            Err(BoxliteError::NotFound(_))
        ));
        assert!(matches!(
            mounts.get(target).await,
            Err(BoxliteError::Unsupported(_))
        ));
        server.await.unwrap()
    })
    .await
    .unwrap();
    let mut requests = requests.into_iter();
    assert_eq!(requests.next().unwrap().0, "GET /v1/boxes/named HTTP/1.1");
    for (method, path, _, _) in operations {
        assert_eq!(requests.next().unwrap().0, "GET /v1/config HTTP/1.1");
        let (line, body) = requests.next().unwrap();
        assert_eq!(line, format!("{method} {path} HTTP/1.1"));
        if method == "POST" {
            assert_eq!(
                serde_json::from_str::<Value>(&body).unwrap(),
                json!({
                    "source": "/host/data", "target": target, "read_only": true,
                })
            );
        }
    }
    assert_eq!(requests.next().unwrap().0, "GET /v1/config HTTP/1.1");
}
