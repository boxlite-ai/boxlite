//! A local OCI registry that answers integration-test image pulls from disk.
//!
//! Every box built from a tag asks its registry for the tag again
//! (`image_for_new_disk` in boxlite's `container_rootfs.rs`). With public
//! mirrors as the test registries, that put a network round trip into every
//! box start — or the 10 s registry connect timeout whenever a mirror stalled.
//! Harness runtimes list this registry instead. It replays what it recorded
//! under `target/boxlite-test/registry/` and fetches only what it has never
//! seen, so a recorded tag never moves.
//!
//! A fetch must answer before a pull stops waiting for bytes (30 s, boxlite's
//! `REGISTRY_READ_TIMEOUT`). So upstreams race rather than take turns, which
//! would spend a connect timeout per stalled mirror, and a blob streams through
//! as it arrives rather than after the whole layer.
//!
//! Layout: `manifests/<repository>/<tag or digest>` and `blobs/<digest>`, each
//! holding the exact bytes an upstream sent, since pulls verify digests.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use boxlite::{ImageRegistry, RegistryTransport};
use futures::StreamExt;
use futures::stream::FuturesUnordered;
use oci_client::client::{ClientConfig, ClientProtocol};
use oci_client::secrets::RegistryAuth;
use oci_client::{Client, Reference, RegistryOperation};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Manifest types a pull accepts; a recording keeps whichever was sent.
const MANIFEST_TYPES: &[&str] = &[
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
];

static PROCESS_REGISTRY: OnceLock<LocalRegistry> = OnceLock::new();

/// This process's registry, the one [`crate::test_registries`] lists.
pub fn local_registry() -> &'static LocalRegistry {
    PROCESS_REGISTRY.get_or_init(|| {
        let upstreams = crate::UPSTREAM_REGISTRIES
            .iter()
            .map(|host| ImageRegistry::https(*host))
            .collect();
        LocalRegistry::start(crate::cache::cache_dir().join("registry"), upstreams)
    })
}

/// A registry on `127.0.0.1` serving one recording directory until dropped.
pub struct LocalRegistry {
    host: String,
    runtime: Option<tokio::runtime::Runtime>,
}

impl LocalRegistry {
    /// Serve `dir`, recording whatever it lacks from `upstreams`.
    pub fn start(dir: PathBuf, upstreams: Vec<ImageRegistry>) -> Self {
        // A runtime of its own: a test's runtime ends with the test, and every
        // later box in the process still pulls through this registry.
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("build local registry runtime");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind local registry");
        listener
            .set_nonblocking(true)
            .expect("make local registry nonblocking");
        let host = listener
            .local_addr()
            .expect("local registry address")
            .to_string();
        let recording = Arc::new(Recording { dir, upstreams });
        runtime.spawn(async move {
            let listener =
                tokio::net::TcpListener::from_std(listener).expect("adopt local registry");
            loop {
                match listener.accept().await {
                    Ok((socket, _)) => {
                        tokio::spawn(answer(socket, recording.clone()));
                    }
                    // Out of descriptors, say: every later pull still needs it.
                    Err(error) => {
                        eprintln!("[test] local registry could not accept: {error}");
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                }
            }
        });
        Self {
            host,
            runtime: Some(runtime),
        }
    }

    /// `127.0.0.1:<port>`.
    pub fn host(&self) -> &str {
        &self.host
    }

    /// This registry as a runtime's search registry, over plain HTTP.
    pub fn search_registry(&self) -> ImageRegistry {
        ImageRegistry::http(&self.host).with_search(true)
    }
}

impl Drop for LocalRegistry {
    fn drop(&mut self) {
        // Never blocks, so a test may drop a registry inside its own runtime.
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_background();
        }
    }
}

/// A body and its media type, or an error code and message.
type Found = Result<(String, Vec<u8>), (&'static str, String)>;

/// One request per connection: read its head, reply, close.
async fn answer(mut socket: TcpStream, recording: Arc<Recording>) {
    let Some((method, path)) = read_request_line(&mut socket).await else {
        return;
    };
    let head_only = method == "HEAD";
    let found = match route(&path) {
        Some(Route::Blob(name, digest)) => {
            let _ = recording.blob(&mut socket, name, digest, head_only).await;
            return;
        }
        Some(Route::Manifest(name, reference)) => recording.manifest(name, reference).await,
        Some(Route::Version) => Ok(("application/json".to_owned(), b"{}".to_vec())),
        None => Err(("NAME_UNKNOWN", format!("no route for {path}"))),
    };
    let _ = reply(&mut socket, found, head_only).await;
}

async fn read_request_line(socket: &mut TcpStream) -> Option<(String, String)> {
    let mut head = Vec::new();
    let mut chunk = [0u8; 2048];
    while !head.windows(4).any(|window| window == b"\r\n\r\n") {
        let read = socket.read(&mut chunk).await.ok()?;
        if read == 0 || head.len() > 16 * 1024 {
            return None;
        }
        head.extend_from_slice(&chunk[..read]);
    }
    let line = std::str::from_utf8(&head).ok()?.lines().next()?;
    let mut words = line.split(' ');
    Some((words.next()?.to_owned(), words.next()?.to_owned()))
}

enum Route<'a> {
    Version,
    Manifest(&'a str, &'a str),
    Blob(&'a str, &'a str),
}

/// The pull endpoints of the distribution spec. A name or reference that could
/// step outside the recording directory is no route at all.
fn route(path: &str) -> Option<Route<'_>> {
    let rest = path.split('?').next()?.strip_prefix("/v2/")?;
    if rest.is_empty() {
        return Some(Route::Version);
    }
    let safe = |part: &str| {
        !part.is_empty()
            && !part.starts_with('.')
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "._-:".contains(c))
    };
    let checked = |name: &str, reference: &str| name.split('/').all(safe) && safe(reference);
    if let Some((name, reference)) = rest.rsplit_once("/manifests/") {
        return checked(name, reference).then_some(Route::Manifest(name, reference));
    }
    let (name, digest) = rest.rsplit_once("/blobs/")?;
    checked(name, digest).then_some(Route::Blob(name, digest))
}

struct Recording {
    dir: PathBuf,
    upstreams: Vec<ImageRegistry>,
}

impl Recording {
    async fn manifest(&self, name: &str, reference: &str) -> Found {
        let path = self.dir.join("manifests").join(name).join(reference);
        if let Ok(body) = std::fs::read(&path) {
            return Ok((media_type(&body), body));
        }
        let fetch = |client: Client, image: Reference| async move {
            let auth = RegistryAuth::Anonymous;
            let (body, _) = client
                .pull_manifest_raw(&image, &auth, MANIFEST_TYPES)
                .await?;
            Ok(body)
        };
        let body = self.first_upstream(name, reference, fetch).await;
        let body = body.map_err(|failures| ("MANIFEST_UNKNOWN", failures))?;
        keep(&path, &body);
        Ok((media_type(&body), body))
    }

    /// A recorded blob, or one streamed in from an upstream and on to the
    /// client as it arrives, then recorded once the stream verifies.
    async fn blob(
        &self,
        socket: &mut TcpStream,
        name: &str,
        digest: &str,
        head_only: bool,
    ) -> std::io::Result<()> {
        let path = self.dir.join("blobs").join(digest);
        if let Ok(body) = std::fs::read(&path) {
            let found = Ok(("application/octet-stream".to_owned(), body));
            return reply(socket, found, head_only).await;
        }
        let fetch = |client: Client, image: Reference| async move {
            client.pull_blob_stream(&image, digest).await
        };
        let mut upstream = match self.first_upstream(name, digest, fetch).await {
            Ok(upstream) => upstream,
            Err(failures) => {
                return reply(socket, Err(("BLOB_UNKNOWN", failures)), head_only).await;
            }
        };
        let length = upstream
            .content_length
            .map(|length| format!("Content-Length: {length}\r\n"))
            .unwrap_or_default();
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\
             Docker-Content-Digest: {digest}\r\n{length}Connection: close\r\n\r\n"
        );
        socket.write_all(head.as_bytes()).await?;
        let mut body = Vec::new();
        // The stream checks the digest and ends in an error on a mismatch.
        while let Some(chunk) = upstream.stream.next().await {
            let chunk = chunk?;
            if !head_only {
                socket.write_all(&chunk).await?;
            }
            body.extend_from_slice(&chunk);
        }
        keep(&path, &body);
        socket.shutdown().await
    }

    /// Whichever upstream answers first, or every upstream's failure.
    async fn first_upstream<T, F, Fut>(
        &self,
        name: &str,
        reference: &str,
        fetch: F,
    ) -> Result<T, String>
    where
        F: Fn(Client, Reference) -> Fut,
        Fut: Future<Output = oci_client::errors::Result<T>>,
    {
        let fetch = &fetch;
        let mut attempts: FuturesUnordered<_> = self
            .upstreams
            .iter()
            .map(|upstream| async move {
                let (registry, repository) = (upstream.host.clone(), name.to_owned());
                let image = if reference.starts_with("sha256:") {
                    Reference::with_digest(registry, repository, reference.to_owned())
                } else {
                    Reference::with_tag(registry, repository, reference.to_owned())
                };
                let client = client_for(upstream);
                let operation = RegistryOperation::Pull;
                let fetched = match client
                    .auth(&image, &RegistryAuth::Anonymous, operation)
                    .await
                {
                    Ok(_) => fetch(client, image).await,
                    Err(error) => Err(error),
                };
                (&upstream.host, fetched)
            })
            .collect();
        let mut failures = Vec::new();
        while let Some((host, fetched)) = attempts.next().await {
            match fetched {
                Ok(found) => {
                    eprintln!("[test] local registry fetches {name} {reference} from {host}");
                    return Ok(found);
                }
                Err(error) => failures.push(format!("{host}: {error}")),
            }
        }
        Err(format!(
            "no upstream has {name} {reference} [{}]",
            failures.join("; ")
        ))
    }
}

/// Bounded like boxlite's own registry client, so a race in which every
/// upstream stalls still ends in an answer.
fn client_for(upstream: &ImageRegistry) -> Client {
    Client::new(ClientConfig {
        protocol: match upstream.transport {
            RegistryTransport::Http => ClientProtocol::Http,
            RegistryTransport::Https => ClientProtocol::Https,
        },
        connect_timeout: Some(Duration::from_secs(10)),
        read_timeout: Some(Duration::from_secs(30)),
        ..Default::default()
    })
}

/// Write `body` to `path` whole or not at all: test processes record side by side.
fn keep(path: &Path, body: &[u8]) {
    let parent = path.parent().expect("a recording has a parent directory");
    let written = std::fs::create_dir_all(parent).and_then(|()| {
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        std::io::Write::write_all(&mut file, body)?;
        file.persist(path).map(drop).map_err(|e| e.error)
    });
    if let Err(error) = written {
        eprintln!(
            "[test] local registry could not record {}: {error}",
            path.display()
        );
    }
}

/// The type a manifest names itself, or the OCI type its shape implies.
fn media_type(manifest: &[u8]) -> String {
    let manifest: serde_json::Value = serde_json::from_slice(manifest).unwrap_or_default();
    match manifest.get("mediaType").and_then(|value| value.as_str()) {
        Some(media_type) => media_type.to_owned(),
        None if manifest.get("manifests").is_some() => MANIFEST_TYPES[0].to_owned(),
        None => MANIFEST_TYPES[1].to_owned(),
    }
}

/// A miss gets the registry's own 404 error envelope, so a pull fails as an
/// answer rather than as a registry that could not be reached.
async fn reply(socket: &mut TcpStream, found: Found, head_only: bool) -> std::io::Result<()> {
    let (status, media_type, body) = match found {
        Ok((media_type, body)) => ("200 OK", media_type, body),
        Err((code, message)) => {
            let errors = serde_json::json!({ "errors": [{ "code": code, "message": message }] });
            (
                "404 Not Found",
                "application/json".to_owned(),
                errors.to_string().into_bytes(),
            )
        }
    };
    let digest = format!("sha256:{}", hex::encode(Sha256::digest(&body)));
    let head = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {media_type}\r\nDocker-Content-Digest: {digest}\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    socket.write_all(head.as_bytes()).await?;
    if !head_only {
        socket.write_all(&body).await?;
    }
    socket.shutdown().await
}
