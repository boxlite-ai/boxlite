use super::*;
use reqwest::Client;
use serde_json::json;

#[test]
fn routing_uses_exact_base_prefix_and_encoded_segments() {
    for (base, prefix) in [
        ("https://example.test/v1", None),
        ("https://example.test/api/v1", Some("")),
        ("https://example.test/base/v1", Some("region/org")),
    ] {
        let root = Url::parse(base).unwrap();
        let prefix_path = prefix
            .filter(|s| !s.is_empty())
            .map(|s| format!("/{s}"))
            .unwrap_or_default();
        for path in [
            "/images/usage",
            "/images/quay.io%2Facme%2Fapp",
            "/boxes/id/snapshots",
        ] {
            let request = Client::new()
                .get(format!("{base}{prefix_path}{path}"))
                .build()
                .unwrap();
            let gate = requirement(&request, &root, prefix).unwrap();
            assert_eq!(gate.is_some(), path.ends_with("snapshots"));
            if let Some(gate) = gate {
                assert_eq!(gate.operation, "listSnapshots");
            }
        }
        let request = Client::new().get(format!("{base}/config")).build().unwrap();
        assert!(requirement(&request, &root, prefix).unwrap().is_none());
        let request = Client::new()
            .get(format!("{base}wrong/boxes"))
            .build()
            .unwrap();
        assert!(requirement(&request, &root, prefix).is_err());
    }
}

#[test]
fn presence_keeps_null_empty_false_and_zero_distinct() {
    let root = Url::parse("https://example.test/v1").unwrap();
    for value in [Value::Null, json!(false), json!(0), json!(""), json!({})] {
        let request = Client::new()
            .post("https://example.test/v1/boxes/id/exec")
            .json(&json!({"user":value}))
            .build()
            .unwrap();
        let gate = requirement(&request, &root, None).unwrap().unwrap();
        assert_eq!(gate.field.unwrap().path, ["user"]);
    }
    for body in [json!({}), json!({"advanced":{"privileged":false}})] {
        let request = Client::new()
            .post("https://example.test/v1/boxes")
            .json(&body)
            .build()
            .unwrap();
        assert!(requirement(&request, &root, None).unwrap().is_none());
    }
    for body in [
        json!({"advanced":{"privileged":true}}),
        json!({"advanced":{"capabilities":{}}}),
    ] {
        let request = Client::new()
            .post("https://example.test/v1/boxes")
            .json(&body)
            .build()
            .unwrap();
        assert!(requirement(&request, &root, None).unwrap().is_some());
    }
}

#[test]
fn query_header_path_rules_preserve_types_and_strongest_requirement() {
    let routes: Vec<Route> = serde_json::from_value(json!([{
        "method":"PUT", "path":"/{prefix}/files/{id}", "operation":"upload",
        "minimum":"0.12.0", "rules":[
            {"location":"query","path":["flag"],"minimum":"0.13.0","condition":"non-default","default":false,"type":"boolean"},
            {"location":"header","path":["x-mode"],"minimum":"0.14.0","condition":"present","type":"string"},
            {"location":"path","path":["id"],"minimum":"0.12.1","condition":"non-default","default":"default","type":"string"}
        ]
    }])).unwrap();
    let root = Url::parse("https://example.test/v1").unwrap();
    for (query, expected) in [("false", "0.12.0"), ("true", "0.13.0")] {
        let request = Client::new()
            .put(format!(
                "https://example.test/v1/org/files/default?flag={query}"
            ))
            .body(reqwest::Body::wrap_stream(futures::stream::pending::<
                Result<bytes::Bytes, std::io::Error>,
            >()))
            .build()
            .unwrap();
        let gate = evaluate(&routes, &request, &root, Some("org"))
            .unwrap()
            .unwrap();
        assert_eq!(gate.minimum.to_string(), expected);
    }
    let request = Client::new()
        .put("https://example.test/v1/org/files/a%2Fb?flag=false&flag=true")
        .header("X-Mode", "custom")
        .build()
        .unwrap();
    let gate = evaluate(&routes, &request, &root, Some("org"))
        .unwrap()
        .unwrap();
    assert_eq!(gate.minimum.to_string(), "0.14.0");
    let request = Client::new()
        .put("https://example.test/v1/org/files/a%2Fb?flag=false")
        .build()
        .unwrap();
    assert_eq!(
        evaluate(&routes, &request, &root, Some("org"))
            .unwrap()
            .unwrap()
            .minimum
            .to_string(),
        "0.12.1"
    );
    let request = Client::new()
        .put("https://example.test/v1/org/files/default?flag=0")
        .build()
        .unwrap();
    assert!(evaluate(&routes, &request, &root, Some("org")).is_err());
}

#[test]
fn static_routes_take_precedence_and_json_streams_fail_closed() {
    let routes: Vec<Route> = serde_json::from_value(json!([
        {"method":"GET","path":"/images/{name}","operation":"image","minimum":"0.12.0","rules":[]},
        {"method":"GET","path":"/images/usage","operation":"usage","minimum":"0.13.0","rules":[]}
    ]))
    .unwrap();
    let root = Url::parse("https://example.test/v1").unwrap();
    let request = Client::new()
        .get("https://example.test/v1/images/usage")
        .build()
        .unwrap();
    assert_eq!(
        evaluate(&routes, &request, &root, None)
            .unwrap()
            .unwrap()
            .operation,
        "usage"
    );
    let request = Client::new()
        .post("https://example.test/v1/boxes/id/exec")
        .body(reqwest::Body::wrap_stream(futures::stream::pending::<
            Result<bytes::Bytes, std::io::Error>,
        >()))
        .build()
        .unwrap();
    assert!(requirement(&request, &root, None).is_err());
}
