//! Conformance test: verify the utoipa-generated OpenAPI spec structurally
//! matches the hand-written spec at `openapi/rest-sandbox-open-api.yaml`.
//!
//! This test does NOT require byte-for-byte equality — descriptions, examples,
//! and ordering may differ. It checks:
//! - All paths + operations exist
//! - All schema names are present
//! - Info metadata matches
//! - Tags are present
//! - Security schemes are defined

use serde_json::Value;
use utoipa::OpenApi;

use boxlite_server::coordinator::ApiDoc;

/// Load the hand-written YAML spec and convert to JSON Value.
fn load_yaml_spec() -> Value {
    let yaml_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../openapi/rest-sandbox-open-api.yaml");
    let yaml_str = std::fs::read_to_string(&yaml_path)
        .unwrap_or_else(|e| panic!("Failed to read {}: {e}", yaml_path.display()));
    serde_yaml::from_str(&yaml_str).expect("Failed to parse YAML spec")
}

/// Generate the utoipa spec as JSON Value.
fn utoipa_spec() -> Value {
    let openapi = ApiDoc::openapi();
    let json_str = openapi
        .to_json()
        .expect("Failed to serialize OpenAPI to JSON");
    serde_json::from_str(&json_str).expect("Failed to parse utoipa JSON")
}

#[test]
fn test_info_metadata() {
    let actual = utoipa_spec();
    let expected = load_yaml_spec();

    assert_eq!(
        actual["info"]["title"].as_str().unwrap(),
        expected["info"]["title"].as_str().unwrap(),
        "Title mismatch"
    );
    assert_eq!(
        actual["info"]["version"].as_str().unwrap(),
        expected["info"]["version"].as_str().unwrap(),
        "Version mismatch"
    );
}

#[test]
fn test_all_yaml_paths_exist() {
    let actual = utoipa_spec();
    let expected = load_yaml_spec();

    let yaml_paths = expected["paths"].as_object().expect("YAML has no paths");
    let utoipa_paths = actual["paths"].as_object().expect("utoipa has no paths");

    // The YAML spec omits the /v1 prefix (it's in the server base URL),
    // while utoipa includes it in each path. Prepend /v1 when checking.
    let mut missing = Vec::new();
    for yaml_path in yaml_paths.keys() {
        let full_path = format!("/v1{yaml_path}");
        if !utoipa_paths.contains_key(full_path.as_str()) {
            missing.push(yaml_path.clone());
        }
    }

    assert!(
        missing.is_empty(),
        "Missing paths in utoipa spec: {missing:?}"
    );
}

#[test]
fn test_all_yaml_operations_exist() {
    let actual = utoipa_spec();
    let expected = load_yaml_spec();

    let yaml_paths = expected["paths"].as_object().expect("YAML has no paths");
    let utoipa_paths = actual["paths"].as_object().expect("utoipa has no paths");

    let http_methods = ["get", "post", "put", "delete", "head", "patch"];
    let mut missing_ops = Vec::new();

    for (path, yaml_ops) in yaml_paths {
        let yaml_ops = yaml_ops.as_object().unwrap();
        let full_path = format!("/v1{path}");
        let utoipa_ops = match utoipa_paths.get(full_path.as_str()) {
            Some(v) => v.as_object().unwrap(),
            None => continue,
        };

        for method in &http_methods {
            if yaml_ops.contains_key(*method) && !utoipa_ops.contains_key(*method) {
                missing_ops.push(format!("{method} {path}"));
            }
        }
    }

    assert!(
        missing_ops.is_empty(),
        "Missing operations in utoipa spec: {missing_ops:?}"
    );
}

#[test]
fn test_all_yaml_schemas_exist() {
    let actual = utoipa_spec();
    let expected = load_yaml_spec();

    let yaml_schemas = expected["components"]["schemas"]
        .as_object()
        .expect("YAML has no schemas");
    let utoipa_schemas = actual["components"]["schemas"]
        .as_object()
        .expect("utoipa has no schemas");

    let mut missing = Vec::new();
    for schema_name in yaml_schemas.keys() {
        if !utoipa_schemas.contains_key(schema_name.as_str()) {
            missing.push(schema_name.clone());
        }
    }

    assert!(
        missing.is_empty(),
        "Missing schemas in utoipa spec: {missing:?}"
    );
}

#[test]
fn test_tags_present() {
    let actual = utoipa_spec();
    let expected = load_yaml_spec();

    let yaml_tags: Vec<&str> = expected["tags"]
        .as_array()
        .expect("YAML has no tags")
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();

    let utoipa_tags: Vec<&str> = actual["tags"]
        .as_array()
        .expect("utoipa has no tags")
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();

    for tag in &yaml_tags {
        assert!(
            utoipa_tags.contains(tag),
            "Missing tag in utoipa spec: {tag}"
        );
    }
}

#[test]
fn test_security_schemes_present() {
    let actual = utoipa_spec();

    let schemes = actual["components"]["securitySchemes"]
        .as_object()
        .expect("utoipa has no securitySchemes");

    assert!(
        schemes.contains_key("BearerAuth"),
        "Missing BearerAuth security scheme"
    );
    assert!(
        schemes.contains_key("OAuth2"),
        "Missing OAuth2 security scheme"
    );

    assert_eq!(schemes["BearerAuth"]["type"].as_str().unwrap(), "http");
    assert_eq!(schemes["BearerAuth"]["scheme"].as_str().unwrap(), "bearer");

    assert!(
        schemes["OAuth2"]["flows"]["clientCredentials"].is_object(),
        "OAuth2 missing clientCredentials flow"
    );
}
