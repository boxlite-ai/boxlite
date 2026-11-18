use super::*;

#[test]
fn serve_accepts_automatic_and_fixed_tcp_publications() {
    for host_port in [None, Some(40141)] {
        let req: CreateBoxRequest = serde_json::from_value(serde_json::json!({
            "image": "alpine",
            "ports": [{"guest_port": 30141, "host_port": host_port, "protocol": "tcp", "host_ip": "0.0.0.0"}]
        }))
        .unwrap();
        let options = build_box_options(&req).unwrap();
        assert_eq!(options.ports.len(), 1);
        assert_eq!(options.ports[0].host_port, host_port);
        assert_eq!(options.ports[0].guest_port, 30141);
        assert_eq!(options.ports[0].host_ip.as_deref(), Some("0.0.0.0"));
    }
    let req: CreateBoxRequest = serde_json::from_str(r#"{"image":"alpine"}"#).unwrap();
    assert!(build_box_options(&req).unwrap().ports.is_empty());
}

#[test]
fn serve_rejects_invalid_publications() {
    for port in [
        serde_json::json!({"guest_port": 0}),
        serde_json::json!({"guest_port": 30141, "protocol": "udp"}),
        serde_json::json!({"guest_port": 30141, "host_ip": "not-an-ip"}),
    ] {
        let req: CreateBoxRequest = serde_json::from_value(serde_json::json!({
            "image": "alpine", "ports": [port]
        }))
        .unwrap();
        assert!(build_box_options(&req).is_err());
    }
    let req: CreateBoxRequest = serde_json::from_value(serde_json::json!({
        "image": "alpine", "network": {"outbound": {"mode": "disabled"}},
        "ports": [{"guest_port": 30141}]
    }))
    .unwrap();
    assert!(build_box_options(&req).is_err());
    for port in [-1, 65536] {
        assert!(
            serde_json::from_value::<CreateBoxRequest>(serde_json::json!({
                "ports": [{"guest_port": port}]
            }))
            .is_err()
        );
    }
}

#[test]
fn serve_reports_actual_publications_and_preserves_unknown_state() {
    let mut info = info_as_the_runtime_reports_it("running");
    info.network = serde_json::from_value(serde_json::json!({
        "outbound": {"mode": "enabled"}, "inbound": {"mode": "disabled"},
        "published_ports": [{"guest_port": 30141, "host_ip": "0.0.0.0", "host_port": 40141, "protocol": "tcp"}]
    })).ok();
    let response = serde_json::to_value(box_info_to_response(&info)).unwrap();
    assert_eq!(
        response["network"]["published_ports"][0]["host_port"],
        40141
    );
    info.network.as_mut().unwrap().published_ports = None;
    let response = serde_json::to_value(box_info_to_response(&info)).unwrap();
    assert!(response["network"].get("published_ports").is_none());
}

#[tokio::test]
async fn serve_publications_require_auth_and_validate_before_creation() {
    let mut state = lifecycle_state();
    state.api_key = Some("test-key".into());
    let (base, task) = serve_router(Arc::new(state)).await;
    let client = reqwest::Client::new();
    let body = serde_json::json!({"image": "alpine", "ports": [{"guest_port": 0}]});
    let denied = client
        .post(format!("{base}/v1/boxes"))
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    let invalid = client
        .post(format!("{base}/v1/boxes"))
        .bearer_auth("test-key")
        .json(&body)
        .send()
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    let config: serde_json::Value = client
        .get(format!("{base}/v1/config"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        config["capabilities"]["local_port_publication_enabled"],
        true
    );
    task.abort();
}
