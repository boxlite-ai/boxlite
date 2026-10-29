use super::*;

#[tokio::test]
async fn workload_keeps_its_endpoint_and_credentials_after_another_process_switches() {
    use axum::{Json, Router, extract::Request};
    use std::sync::{Arc, Mutex};

    // SAFETY: nextest isolates tests in processes; the Cargo fallback runs
    // CLI unit tests with --test-threads=1.
    for variable in [
        "BOXLITE_CONTEXT",
        "BOXLITE_PROFILE",
        "BOXLITE_REST_URL",
        "BOXLITE_REST_PATH_PREFIX",
        "BOXLITE_API_KEY",
    ] {
        unsafe { std::env::remove_var(variable) };
    }
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = requests.clone();
    let app = Router::new().fallback(move |request: Request| {
        let recorded = recorded.clone();
        async move {
            recorded.lock().unwrap().push((
                request.uri().path().to_string(),
                request.headers()["authorization"]
                    .to_str()
                    .unwrap()
                    .to_string(),
            ));
            Json(serde_json::json!({"boxes": []}))
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let home = tempfile::TempDir::new().unwrap();
    let preference_path = home.path().join("cli.toml");
    let credential_path = home.path().join("credentials.toml");
    std::fs::write(&preference_path, "current_context = 'cloud'\n").unwrap();
    std::fs::write(
        &credential_path,
        format!(
            "[profiles.cloud]\nurl = '{url}'\napi_key = 'snapshot-key'\npath_prefix = 'tenant'\n"
        ),
    )
    .unwrap();
    let arguments = ["boxlite", "--home", home.path().to_str().unwrap(), "list"];
    let mut cli = crate::cli::try_parse_from(arguments).unwrap();
    initialize(&mut cli).unwrap();
    assert!(cli.global.targets_rest().unwrap());

    // Simulate another process changing both files between backend detection
    // and runtime construction; the actual HTTP request must use the snapshot.
    std::fs::write(&preference_path, "current_context = 'staging'\n").unwrap();
    std::fs::remove_file(&credential_path).unwrap();
    assert!(cli.global.targets_rest().unwrap());
    cli.global
        .create_runtime()
        .unwrap()
        .list_info()
        .await
        .unwrap();
    assert_eq!(
        *requests.lock().unwrap(),
        [(
            "/v1/tenant/boxes".to_string(),
            "Bearer snapshot-key".to_string()
        )]
    );

    let mut next_invocation = crate::cli::try_parse_from(arguments).unwrap();
    assert!(
        initialize(&mut next_invocation)
            .unwrap_err()
            .to_string()
            .contains("context `staging` not found")
    );
    server.abort();
}
