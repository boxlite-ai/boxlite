use super::*;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkpoint_management_routes_validate_requests_and_preserve_absence_and_auth() {
    let home = tempfile::tempdir().unwrap();
    let runtime = BoxliteRuntime::new_for_test(boxlite::BoxliteOptions {
        home_dir: home.path().join("runtime"),
        ..Default::default()
    })
    .unwrap();
    let source = runtime
        .create(BoxOptions::default(), Some("source".into()))
        .await
        .unwrap();
    let mut state = lifecycle_state();
    state.runtime = runtime.clone();
    state.api_key = Some("checkpoint-key".into());
    let (url, server) = serve_router(Arc::new(state)).await;
    let client = reqwest::Client::new();
    for path in [
        "checkpoints".to_owned(),
        format!("boxes/{}/checkpoints", source.id()),
    ] {
        assert_eq!(
            client
                .get(format!("{url}/v1/{path}"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let response = client
            .get(format!("{url}/v1/{path}"))
            .bearer_auth("checkpoint-key")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.json::<serde_json::Value>().await.unwrap()["checkpoints"],
            serde_json::json!([])
        );
    }
    for path in [
        "checkpoints/missing".to_owned(),
        format!("boxes/{}/checkpoints/missing", source.id()),
    ] {
        for method in [reqwest::Method::GET, reqwest::Method::DELETE] {
            let response = client
                .request(method, format!("{url}/v1/{path}"))
                .bearer_auth("checkpoint-key")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            assert_eq!(
                response.json::<serde_json::Value>().await.unwrap()["error"]["code"],
                "not_found"
            );
        }
    }
    for path in [
        format!("boxes/{}/checkpoints", source.id()),
        "checkpoints/missing/boxes".into(),
    ] {
        for body in [r#"{"name":null}"#, r#"{"unknown":1}"#, "{"] {
            let response = client
                .post(format!("{url}/v1/{path}"))
                .bearer_auth("checkpoint-key")
                .header("Content-Type", "application/json")
                .body(body)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{path} {body}");
            assert_eq!(
                response.json::<serde_json::Value>().await.unwrap()["error"]["code"],
                "invalid_argument"
            );
        }
    }
    assert_eq!(runtime.list_info().await.unwrap().len(), 1);
    assert!(
        runtime
            .checkpoints()
            .unwrap()
            .list()
            .await
            .unwrap()
            .is_empty()
    );
    server.abort();
}
