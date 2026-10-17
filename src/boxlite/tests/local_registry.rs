//! The registry integration tests resolve images against.

mod common;

use std::path::Path;

use boxlite::ImageRegistry;
use boxlite::runtime::options::BoxliteOptions;
use common::home::PerTestBoxHome;
use common::registry::LocalRegistry;
use sha2::{Digest, Sha256};

/// Every box a test builds from a tag asks its registry for that tag again, so
/// a host off this machine puts the internet into every box start.
#[test]
fn harness_registries_stay_on_this_machine() {
    let registries = common::test_registries();
    assert!(!registries.is_empty(), "the harness lists no registry");
    for registry in registries {
        let address = registry
            .host
            .parse::<std::net::SocketAddr>()
            .unwrap_or_else(|_| panic!("{} is not an address on this machine", registry.host));
        assert!(
            address.ip().is_loopback(),
            "{} is not an address on this machine",
            registry.host
        );
    }
}

/// Once the registry has served an image, it serves it again with its upstream
/// gone, which is what keeps a box start off the internet.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_recorded_image_is_served_with_its_upstream_gone() {
    let source = tempfile::tempdir().unwrap();
    let built = seed_image(source.path(), "acme/app", "v1");
    let upstream = LocalRegistry::start(source.path().to_path_buf(), Vec::new());

    let recording = tempfile::tempdir().unwrap();
    let registry = LocalRegistry::start(
        recording.path().to_path_buf(),
        vec![ImageRegistry::http(upstream.host())],
    );
    assert_eq!(pull(&registry, "acme/app:v1").await, built);

    drop(upstream);
    assert_eq!(pull(&registry, "acme/app:v1").await, built);
}

/// An upstream that is down loses the race instead of failing the fetch.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_upstream_that_is_down_does_not_fail_a_fetch() {
    let source = tempfile::tempdir().unwrap();
    let built = seed_image(source.path(), "acme/app", "v1");
    let upstream = LocalRegistry::start(source.path().to_path_buf(), Vec::new());

    let recording = tempfile::tempdir().unwrap();
    // Nothing listens on port 1, so that upstream refuses every connection.
    let registry = LocalRegistry::start(
        recording.path().to_path_buf(),
        vec![
            ImageRegistry::http("127.0.0.1:1"),
            ImageRegistry::http(upstream.host()),
        ],
    );
    assert_eq!(pull(&registry, "acme/app:v1").await, built);
}

/// A path that climbs out of the recording is no route, so a request cannot
/// read the files beside it.
#[test]
fn a_path_out_of_the_recording_is_refused() {
    let recording = tempfile::tempdir().unwrap();
    seed_image(recording.path(), "acme/app", "v1");
    std::fs::write(recording.path().join("secret"), "beside the recording").unwrap();
    let registry = LocalRegistry::start(recording.path().to_path_buf(), Vec::new());

    for path in [
        "/v2/acme/app/manifests/../../../secret",
        "/v2/acme/app/../../../manifests/secret",
        "/v2/acme/app/blobs/../secret",
    ] {
        let response = raw_get(registry.host(), path);
        assert!(response.starts_with("HTTP/1.1 404"), "{path}: {response}");
        assert!(
            !response.contains("beside the recording"),
            "{path}: {response}"
        );
    }
}

/// The raw response to `GET path`, sent as written so nothing normalizes it.
fn raw_get(host: &str, path: &str) -> String {
    use std::io::{Read, Write};
    let mut stream = std::net::TcpStream::connect(host).unwrap();
    write!(stream, "GET {path} HTTP/1.1\r\nHost: {host}\r\n\r\n").unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}

/// The manifest digest a fresh runtime pulls `image` at, through `registry` alone.
async fn pull(registry: &LocalRegistry, image: &str) -> String {
    let home = PerTestBoxHome::isolated_in("/tmp");
    let runtime = common::non_vm_runtime(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: vec![registry.search_registry()],
    })
    .unwrap();
    let pulled = runtime
        .images()
        .unwrap()
        .pull(image)
        .await
        .expect("pull through the local registry");
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
    pulled.manifest_digest().to_owned()
}

/// A one-layer image in the registry's layout, returning its manifest digest.
/// Only a pull reads it, so the layer never has to unpack.
fn seed_image(dir: &Path, repository: &str, tag: &str) -> String {
    let config =
        br#"{"architecture":"amd64","os":"linux","rootfs":{"type":"layers","diff_ids":[]}}"#;
    let layer = b"layer bytes";
    let manifest = serde_json::json!({
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "config": {
            "mediaType": "application/vnd.oci.image.config.v1+json",
            "digest": digest(config),
            "size": config.len(),
        },
        "layers": [{
            "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
            "digest": digest(layer),
            "size": layer.len(),
        }],
    })
    .to_string();
    for (path, body) in [
        (dir.join("blobs").join(digest(config)), &config[..]),
        (dir.join("blobs").join(digest(layer)), &layer[..]),
        (
            dir.join("manifests").join(repository).join(tag),
            manifest.as_bytes(),
        ),
    ] {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }
    digest(manifest.as_bytes())
}

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}
