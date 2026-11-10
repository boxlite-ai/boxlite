use super::*;
use boxlite::experimental::{ExperimentalFeature, RuntimeBuilder};

#[tokio::test]
async fn nested_policy_reuse_matches_local_through_rest() {
    const CASE: &str = "BOXLITE_REST_REUSE_TEST_CASE";
    let Ok(case) = std::env::var(CASE) else {
        for value in ["", "nested-virtualization"] {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "commands::serve::tests::nested_reuse::nested_policy_reuse_matches_local_through_rest", "--nocapture"])
                .env(CASE, value)
                .env("BOXLITE_EXPERIMENTAL", value)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{value}: {}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        return;
    };
    let enabled = !case.is_empty();
    let home = tempfile::tempdir().unwrap();
    let options = boxlite::BoxliteOptions {
        home_dir: home.path().join("runtime"),
        ..Default::default()
    };
    let fixture = RuntimeBuilder::new(options.clone())
        .enable(ExperimentalFeature::NestedVirtualization)
        .build_for_runner_test()
        .unwrap();
    for (name, nested) in [("ordinary", false), ("nested", true)] {
        let mut box_options = BoxOptions {
            detach: true,
            auto_delete: Some(0),
            ..Default::default()
        };
        boxlite::experimental::runner::set_nested_virtualization(&mut box_options.advanced, nested);
        fixture
            .create(box_options, Some(name.into()))
            .await
            .unwrap();
    }
    fixture.shutdown(Some(0)).await.unwrap();
    drop(fixture);
    let runtime = BoxliteRuntime::new_for_test(options).unwrap();
    // Only this test executes in the child; subsequent operations must use its snapshot.
    unsafe {
        std::env::set_var(
            "BOXLITE_EXPERIMENTAL",
            if enabled { "" } else { "nested-virtualization" },
        );
    }
    let mut state = lifecycle_state();
    state.runtime = runtime.clone();
    let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorded = requests.clone();
    let app = build_router(Arc::new(state)).layer(middleware::from_fn(
        move |request: axum::extract::Request, next: middleware::Next| {
            let recorded = recorded.clone();
            async move {
                recorded.lock().unwrap().push(format!(
                    "{} {}",
                    request.method(),
                    request.uri().path()
                ));
                next.run(request).await
            }
        },
    ));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let remote = BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(format!(
        "http://{address}"
    )))
    .unwrap();
    for name in ["ordinary", "nested"] {
        let info = runtime.get_info(name).await.unwrap().unwrap();
        for identifier in [name, info.id.as_str()] {
            let body: serde_json::Value =
                reqwest::get(format!("http://{address}/v1/boxes/{identifier}"))
                    .await
                    .unwrap()
                    .error_for_status()
                    .unwrap()
                    .json()
                    .await
                    .unwrap();
            let denied = enabled && name == "ordinary";
            assert_eq!(
                body.get("reuse_error").is_some(),
                denied,
                "{case}/{identifier}: {body}"
            );
            assert!(remote.get(identifier).await.unwrap().is_some());
            assert!(remote.get_info(identifier).await.unwrap().is_some());
        }
        let local = runtime
            .get_or_create(BoxOptions::default(), Some(name.into()))
            .await;
        let rest = remote
            .get_or_create(BoxOptions::default(), Some(name.into()))
            .await;
        for result in [local, rest] {
            if enabled && name == "ordinary" {
                assert!(
                    matches!(result, Err(boxlite::BoxliteError::Unsupported(ref message)) if message.contains("without nested virtualization"))
                );
            } else {
                let (_, created) = result.unwrap();
                assert!(!created);
            }
        }
    }
    {
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 14);
        assert!(
            requests
                .iter()
                .all(|request| request.starts_with("GET /v1/boxes/")),
            "{requests:?}"
        );
    }
    server.abort();
    let _ = server.await;
    runtime.shutdown(Some(0)).await.unwrap();
}
