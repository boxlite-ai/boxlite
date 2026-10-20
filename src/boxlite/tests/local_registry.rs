//! The registry integration tests resolve images against.

mod common;

use std::io::{Read, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use boxlite::ImageRegistry;
use boxlite::runtime::options::BoxliteOptions;
use common::home::PerTestBoxHome;
use common::registry::LocalRegistry;
use sha2::{Digest, Sha256};

/// Every box a test builds from a tag asks its registry for that tag again, so
/// a host off this machine puts the internet into every box start.
#[test]
fn harness_registries_stay_on_this_machine() {
    if std::env::var(REGISTRIES_MODE).as_deref() == Ok("upstream") {
        return; // upstream_mode_lists_the_public_mirrors covers that run.
    }
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

/// The variable that switches the harness back to the public mirrors.
const REGISTRIES_MODE: &str = "BOXLITE_TEST_REGISTRIES";

/// `upstream` mode lists the public mirrors again, so a run can still exercise
/// the registries the suites pulled from before the local one.
#[tokio::test]
async fn upstream_mode_lists_the_public_mirrors() {
    if std::env::var(REGISTRIES_MODE).as_deref() != Ok("upstream") {
        // Only the child sees upstream mode, even with parallel libtest tests.
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "upstream_mode_lists_the_public_mirrors"])
            .env(REGISTRIES_MODE, "upstream")
            .kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(10), command.output())
            .await
            .expect("isolated registry test must finish")
            .unwrap();
        assert!(
            output.status.success() && String::from_utf8_lossy(&output.stdout).contains("1 passed"),
            "isolated registry test failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        return;
    }
    let hosts: Vec<_> = common::test_registries()
        .into_iter()
        .map(|registry| registry.host)
        .collect();
    assert_eq!(hosts, common::UPSTREAM_REGISTRIES);
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

/// A blob whose bytes fail their digest fails the pull and leaves nothing behind,
/// not even a partial file, so the next attempt races the upstreams again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_blob_that_fails_its_digest_is_not_recorded() {
    let source = tempfile::tempdir().unwrap();
    seed_image(source.path(), "acme/app", "v1");
    let layer = digest(b"layer bytes");
    std::fs::write(source.path().join("blobs").join(&layer), b"LAYER BYTES").unwrap();
    let upstream = LocalRegistry::start(source.path().to_path_buf(), Vec::new());

    let recording = tempfile::tempdir().unwrap();
    let registry = LocalRegistry::start(
        recording.path().to_path_buf(),
        vec![ImageRegistry::http(upstream.host())],
    );
    assert!(try_pull(&registry, "acme/app:v1").await.is_err());

    // The pull stops at the bad layer, so the config may not have been asked
    // for. The registry drops its temporary file when its own stream fails,
    // which can come just after the client gives up.
    let blobs = recording.path().join("blobs");
    let verified_only = || names_in(&blobs).iter().all(|name| *name == digest(CONFIG));
    assert!(
        eventually(verified_only),
        "only a verified blob may be recorded: {:?}",
        names_in(&blobs)
    );
}

/// A miss reaches disk as it arrives rather than after the whole layer, so a
/// cold pull of a large image never holds its layers in memory.
#[test]
fn a_missed_blob_reaches_disk_as_it_arrives() {
    let blob = vec![7u8; 256 * 1024];
    let sent = blob.len() / 2;
    let upstream = stalling_upstream(&blob, sent);
    let recording = tempfile::tempdir().unwrap();
    let registry = LocalRegistry::start(
        recording.path().to_path_buf(),
        vec![ImageRegistry::http(&upstream)],
    );

    let mut client = std::net::TcpStream::connect(registry.host()).unwrap();
    let request = format!("GET /v2/acme/app/blobs/{} HTTP/1.1\r\n\r\n", digest(&blob));
    client.write_all(request.as_bytes()).unwrap();
    let mut response = Vec::new();
    let mut chunk = [0u8; 16 * 1024];
    while body_len(&response) < sent {
        let read = client.read(&mut chunk).unwrap();
        assert!(
            read > 0,
            "the registry closed after {} bytes",
            body_len(&response)
        );
        response.extend_from_slice(&chunk[..read]);
    }

    // The upstream is stalled, so whatever is on disk arrived before the end.
    let blobs = recording.path().join("blobs");
    assert!(
        eventually(|| bytes_in(&blobs) == sent as u64),
        "{} of {sent} bytes on disk",
        bytes_in(&blobs)
    );
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

/// A registry that answers `/v2/`, then sends the first `sent` bytes of `blob`
/// and holds the connection open, like a mirror stalled partway through.
fn stalling_upstream(blob: &[u8], sent: usize) -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let host = listener.local_addr().unwrap().to_string();
    let (length, start) = (blob.len(), blob[..sent].to_vec());
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let (mut stream, start) = (stream.unwrap(), start.clone());
            std::thread::spawn(move || {
                let mut request = [0u8; 4096];
                let read = stream.read(&mut request).unwrap_or(0);
                if request[..read].starts_with(b"GET /v2/ ") {
                    let _ = stream.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                    );
                    return;
                }
                let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {length}\r\n\r\n");
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(&start);
                std::thread::sleep(Duration::from_secs(60));
            });
        }
    });
    host
}

/// Body bytes in a raw response read so far.
fn body_len(response: &[u8]) -> usize {
    response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map_or(0, |end| response.len() - end - 4)
}

/// Whether `check` holds within a few seconds.
fn eventually(mut check: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if check() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    check()
}

fn names_in(dir: &Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect()
}

fn bytes_in(dir: &Path) -> u64 {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .map(|entry| entry.unwrap().metadata().unwrap().len())
        .sum()
}

/// The raw response to `GET path`, sent as written so nothing normalizes it.
fn raw_get(host: &str, path: &str) -> String {
    let mut stream = std::net::TcpStream::connect(host).unwrap();
    write!(stream, "GET {path} HTTP/1.1\r\nHost: {host}\r\n\r\n").unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}

/// The manifest digest a fresh runtime pulls `image` at, through `registry` alone.
async fn pull(registry: &LocalRegistry, image: &str) -> String {
    try_pull(registry, image)
        .await
        .expect("pull through the local registry")
}

async fn try_pull(registry: &LocalRegistry, image: &str) -> boxlite::BoxliteResult<String> {
    let home = PerTestBoxHome::isolated_in("/tmp");
    let runtime = common::non_vm_runtime(BoxliteOptions {
        home_dir: home.path.clone(),
        image_registries: vec![registry.search_registry()],
        ..Default::default()
    })
    .unwrap();
    let pulled = runtime.images().unwrap().pull(image).await;
    runtime
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .unwrap();
    Ok(pulled?.manifest_digest().to_owned())
}

/// The config blob of every image [`seed_image`] builds.
const CONFIG: &[u8] =
    br#"{"architecture":"amd64","os":"linux","rootfs":{"type":"layers","diff_ids":[]}}"#;

/// A one-layer image in the registry's layout, returning its manifest digest.
/// Only a pull reads it, so the layer never has to unpack.
fn seed_image(dir: &Path, repository: &str, tag: &str) -> String {
    let config = CONFIG;
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
        (dir.join("blobs").join(digest(config)), config),
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
