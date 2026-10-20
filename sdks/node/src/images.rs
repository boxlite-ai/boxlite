use crate::registries::JsRegistryHandle;
use std::sync::Arc;

use boxlite::ImageHandle;
use boxlite::runtime::types::{ImageAliasEvent, ImageDetail, ImageInfo, ImageUsage, ImageVersion};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::util::map_err;

/// Public metadata about a cached image.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsImageInfo {
    pub reference: String,
    pub repository: String,
    pub tag: String,
    pub id: String,
    #[napi(js_name = "cachedAt")]
    pub cached_at: String,
    #[napi(js_name = "sizeBytes")]
    pub size_bytes: Option<i64>,
}

impl From<ImageInfo> for JsImageInfo {
    fn from(info: ImageInfo) -> Self {
        Self {
            reference: info.reference,
            repository: info.repository,
            tag: info.tag,
            id: info.id,
            cached_at: info.cached_at.to_rfc3339(),
            size_bytes: info.size.map(|size| js_number(size.as_bytes())),
        }
    }
}

/// A count or byte size as the i64 napi hands JS as a number.
///
/// Saturating keeps the JS number surface stable if a backend ever reports a
/// value beyond signed 64-bit range.
fn js_number(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

/// Result metadata returned from an image pull operation.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsImagePullResult {
    pub reference: String,
    #[napi(js_name = "configDigest")]
    pub config_digest: String,
    #[napi(js_name = "layerCount")]
    pub layer_count: u32,
}

/// One build of an image.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsImageVersion {
    /// Manifest digest, such as "sha256:…".
    pub digest: String,
    /// Sum of the layer sizes the manifest declares; absent when unknown.
    #[napi(js_name = "sizeBytes")]
    pub size_bytes: Option<i64>,
    /// The reference that was pulled to get this build.
    #[napi(js_name = "sourceRef")]
    pub source_ref: String,
    /// When this build was recorded, as an RFC 3339 string.
    #[napi(js_name = "recordedAt")]
    pub recorded_at: String,
    /// The image's aliases that point at this build.
    pub aliases: Vec<String>,
    /// When a box last started from this build; absent when unknown.
    #[napi(js_name = "lastUsedAt")]
    pub last_used_at: Option<String>,
    /// When a pull found this build gone from its registry; absent while it is
    /// not known to be gone.
    #[napi(js_name = "upstreamMissingAt")]
    pub upstream_missing_at: Option<String>,
}

impl From<ImageVersion> for JsImageVersion {
    fn from(version: ImageVersion) -> Self {
        Self {
            digest: version.digest,
            size_bytes: version.size_bytes.map(js_number),
            source_ref: version.source_ref,
            recorded_at: version.recorded_at.to_rfc3339(),
            aliases: version.aliases,
            last_used_at: version.last_used_at.map(|time| time.to_rfc3339()),
            upstream_missing_at: version.upstream_missing_at.map(|time| time.to_rfc3339()),
        }
    }
}

/// An alias registration or historical binding change; versions named by
/// digest.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsImageAliasEvent {
    pub alias: String,
    /// The build the alias pointed at before; absent when the alias was new.
    #[napi(js_name = "fromDigest")]
    pub from_digest: Option<String>,
    #[napi(js_name = "toDigest")]
    pub to_digest: String,
    /// Who recorded the alias; absent when a pull recorded it.
    pub actor: Option<String>,
    /// As an RFC 3339 string.
    #[napi(js_name = "recordedAt")]
    pub recorded_at: String,
}

impl From<ImageAliasEvent> for JsImageAliasEvent {
    fn from(event: ImageAliasEvent) -> Self {
        Self {
            alias: event.alias,
            from_digest: event.from_digest,
            to_digest: event.to_digest,
            actor: event.actor,
            recorded_at: event.recorded_at.to_rfc3339(),
        }
    }
}

/// An image name and every build the runtime holds under it.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsImageDetail {
    /// Registry and repository without a tag, such as "docker.io/library/alpine".
    pub name: String,
    pub aliases: Vec<String>,
    /// Provided by the server's operator rather than pulled by a box.
    pub curated: bool,
    /// Newest first.
    pub versions: Vec<JsImageVersion>,
    /// The latest alias history entries, newest first; empty on a local cache.
    pub history: Vec<JsImageAliasEvent>,
}

impl From<ImageDetail> for JsImageDetail {
    fn from(detail: ImageDetail) -> Self {
        Self {
            name: detail.name,
            aliases: detail.aliases,
            curated: detail.curated,
            versions: detail
                .versions
                .into_iter()
                .map(JsImageVersion::from)
                .collect(),
            history: detail
                .history
                .into_iter()
                .map(JsImageAliasEvent::from)
                .collect(),
        }
    }
}

/// Images held against the allowance, on a REST runtime.
#[napi(object)]
#[derive(Clone, Debug)]
pub struct JsImageUsage {
    pub count: i64,
    pub limit: i64,
    /// Sum of the sizes the held builds' manifests declare; a layer two builds
    /// share counts for each.
    #[napi(js_name = "knownBytes")]
    pub known_bytes: i64,
}

impl From<ImageUsage> for JsImageUsage {
    fn from(usage: ImageUsage) -> Self {
        Self {
            count: js_number(usage.count),
            limit: js_number(usage.limit),
            known_bytes: js_number(usage.known_bytes),
        }
    }
}

/// Runtime-scoped handle for image operations.
#[napi]
pub struct JsImageHandle {
    pub(crate) handle: Arc<ImageHandle>,
}

#[napi]
impl JsImageHandle {
    /// Pull an image and return metadata about the cached result.
    #[napi]
    pub async fn pull(&self, reference: String) -> Result<JsImagePullResult> {
        let handle = Arc::clone(&self.handle);
        let image = handle.pull(&reference).await.map_err(map_err)?;
        Ok(JsImagePullResult {
            reference: image.reference().to_string(),
            config_digest: image.config_digest().to_string(),
            // Saturating cast keeps the public JS contract stable even if the
            // underlying count type ever grows wider than u32.
            layer_count: u32::try_from(image.layer_count()).unwrap_or(u32::MAX),
        })
    }

    /// Get the server's registry logins. Throws `unsupported` on a local
    /// runtime, which pulls with the logins in `imageRegistries` instead.
    #[napi(getter)]
    pub fn registries(&self) -> Result<JsRegistryHandle> {
        let handle = self.handle.registries().map_err(map_err)?;
        Ok(JsRegistryHandle {
            handle: Arc::new(handle),
        })
    }

    /// List cached images for this runtime.
    #[napi]
    pub async fn list(&self) -> Result<Vec<JsImageInfo>> {
        let handle = Arc::clone(&self.handle);
        let infos = handle.list().await.map_err(map_err)?;
        Ok(infos.into_iter().map(JsImageInfo::from).collect())
    }

    /// Every build held under an image name, such as "docker.io/library/alpine".
    #[napi]
    pub async fn get(&self, name: String) -> Result<JsImageDetail> {
        let handle = Arc::clone(&self.handle);
        let detail = handle.get(&name).await.map_err(map_err)?;
        Ok(JsImageDetail::from(detail))
    }

    /// Stop holding an image name, every tag of it.
    #[napi]
    pub async fn remove(&self, name: String) -> Result<()> {
        let handle = Arc::clone(&self.handle);
        handle.remove(&name).await.map_err(map_err)
    }

    /// Images held against the allowance; REST runtimes only.
    #[napi]
    pub async fn usage(&self) -> Result<JsImageUsage> {
        let handle = Arc::clone(&self.handle);
        let usage = handle.usage().await.map_err(map_err)?;
        Ok(JsImageUsage::from(usage))
    }

    /// Create a catalog alias for a ready version, refusing an existing alias; REST
    /// runtimes only.
    #[napi(js_name = "createAlias")]
    pub async fn create_alias(
        &self,
        name: String,
        alias: String,
        digest: String,
    ) -> Result<JsImageDetail> {
        let handle = Arc::clone(&self.handle);
        let detail = handle
            .create_alias(&name, &alias, &digest)
            .await
            .map_err(map_err)?;
        Ok(JsImageDetail::from(detail))
    }
    /// Delete only a catalog alias; REST runtimes only.
    #[napi(js_name = "deleteAlias")]
    pub async fn delete_alias(&self, name: String, alias: String) -> Result<()> {
        self.handle
            .delete_alias(&name, &alias)
            .await
            .map_err(map_err)
    }
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, SystemTime};

    use boxlite::runtime::types::Bytes;
    use boxlite::{BoxliteRestOptions, BoxliteRuntime};

    use super::*;

    fn version(digest: &str, size_bytes: Option<u64>, recorded_secs: u64) -> ImageVersion {
        ImageVersion {
            digest: digest.to_string(),
            size_bytes,
            source_ref: format!("quay.io/acme/app@{digest}"),
            recorded_at: (SystemTime::UNIX_EPOCH + Duration::from_secs(recorded_secs)).into(),
            aliases: Vec::new(),
            last_used_at: None,
            upstream_missing_at: None,
        }
    }

    fn info(size: Option<Bytes>) -> ImageInfo {
        ImageInfo {
            reference: "quay.io/acme/app:v1".to_string(),
            repository: "quay.io/acme/app".to_string(),
            tag: "v1".to_string(),
            id: "sha256:aa".to_string(),
            cached_at: (SystemTime::UNIX_EPOCH + Duration::from_secs(3)).into(),
            size,
        }
    }

    #[test]
    fn image_detail_keeps_every_version_newest_first() {
        let detail = JsImageDetail::from(ImageDetail {
            name: "quay.io/acme/app".to_string(),
            aliases: vec!["v2".to_string(), "v1".to_string()],
            curated: true,
            versions: vec![
                version("sha256:bb", Some(4096), 2),
                version("sha256:aa", None, 1),
            ],
            history: Vec::new(),
        });

        assert_eq!(detail.name, "quay.io/acme/app");
        assert_eq!(detail.aliases, ["v2", "v1"]);
        assert!(detail.curated);
        let [newest, oldest] = detail.versions.as_slice() else {
            panic!("expected two versions, got {:?}", detail.versions);
        };
        assert_eq!(newest.digest, "sha256:bb");
        assert_eq!(newest.size_bytes, Some(4096));
        assert_eq!(newest.source_ref, "quay.io/acme/app@sha256:bb");
        assert_eq!(newest.recorded_at, "1970-01-01T00:00:02+00:00");
        assert_eq!(oldest.digest, "sha256:aa");
        assert_eq!(oldest.size_bytes, None);
    }

    #[test]
    fn image_info_reports_its_size_when_known() {
        let sized = JsImageInfo::from(info(Some(Bytes::from_bytes(4096))));
        assert_eq!(sized.size_bytes, Some(4096));
        assert_eq!(sized.cached_at, "1970-01-01T00:00:03+00:00");

        assert_eq!(JsImageInfo::from(info(None)).size_bytes, None);
    }

    /// JS numbers come through napi as i64. A value past i64::MAX must stay
    /// the largest number rather than wrap to a negative one.
    #[test]
    fn counts_and_sizes_past_i64_saturate() {
        let past_i64 = i64::MAX as u64 + 1;

        let usage = JsImageUsage::from(ImageUsage {
            count: 3,
            limit: i64::MAX as u64,
            known_bytes: past_i64,
        });
        assert_eq!(
            (usage.count, usage.limit, usage.known_bytes),
            (3, i64::MAX, i64::MAX)
        );

        let version = JsImageVersion::from(version("sha256:aa", Some(u64::MAX), 0));
        assert_eq!(version.size_bytes, Some(i64::MAX));

        let info = JsImageInfo::from(info(Some(Bytes::from_bytes(past_i64))));
        assert_eq!(info.size_bytes, Some(i64::MAX));
    }

    /// Answers one connection per `(status, body)`, in order, and returns the
    /// request line of each.
    fn http_server(replies: Vec<(u16, &'static str)>) -> (String, JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body) in replies {
                let (mut socket, _) = listener.accept().unwrap();
                let mut reader = BufReader::new(socket.try_clone().unwrap());
                let mut request_line = String::new();
                reader.read_line(&mut request_line).unwrap();
                let mut header = String::new();
                while header != "\r\n" {
                    header.clear();
                    reader.read_line(&mut header).unwrap();
                }
                requests.push(request_line.trim_end().to_string());
                write!(
                    socket,
                    "HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
                .unwrap();
            }
            requests
        });
        (url, server)
    }

    fn images_at(url: String) -> JsImageHandle {
        let runtime = BoxliteRuntime::rest(BoxliteRestOptions::new(url)).unwrap();
        JsImageHandle {
            handle: Arc::new(runtime.images().unwrap()),
        }
    }

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        tokio::runtime::Runtime::new().unwrap().block_on(future)
    }

    #[test]
    fn get_reads_the_name_and_its_versions_from_a_rest_server() {
        let (url, server) = http_server(vec![(
            200,
            r#"{"name":"quay.io/acme/app","aliases":["v1"],"curated":false,"versions":[{"digest":"sha256:aa","size_bytes":42,"source_ref":"quay.io/acme/app:v1","recorded_at":"2026-01-02T03:04:05Z"}]}"#,
        )]);

        let detail = block_on(images_at(url).get("quay.io/acme/app".to_string())).unwrap();

        assert_eq!(
            server.join().unwrap(),
            ["GET /v1/images/quay.io%2Facme%2Fapp HTTP/1.1"]
        );
        assert_eq!(detail.name, "quay.io/acme/app");
        assert_eq!(detail.versions[0].size_bytes, Some(42));
        assert_eq!(detail.versions[0].recorded_at, "2026-01-02T03:04:05+00:00");
    }

    #[test]
    fn remove_deletes_the_name_on_a_rest_server() {
        let (url, server) = http_server(vec![(204, "")]);

        block_on(images_at(url).remove("quay.io/acme/app".to_string())).unwrap();

        assert_eq!(
            server.join().unwrap(),
            ["DELETE /v1/images/quay.io%2Facme%2Fapp HTTP/1.1"]
        );
    }

    #[test]
    fn usage_reads_count_limit_and_bytes_from_a_rest_server() {
        let (url, server) =
            http_server(vec![(200, r#"{"count":3,"limit":20,"known_bytes":4096}"#)]);

        let usage = block_on(images_at(url).usage()).unwrap();

        assert_eq!(server.join().unwrap(), ["GET /v1/images/usage HTTP/1.1"]);
        assert_eq!((usage.count, usage.limit, usage.known_bytes), (3, 20, 4096));
    }

    /// `errorCode()` in lib/errors.ts reads the code off the Display prefix,
    /// so a refusal must reach JS as that text, unwrapped.
    #[test]
    fn a_refusal_from_the_server_reaches_js_as_its_display_text() {
        let (url, _server) = http_server(vec![(
            409,
            r#"{"error":{"message":"in use by box b1","type":"InvalidStateError","code":"invalid_state"}}"#,
        )]);

        let error = block_on(images_at(url).remove("quay.io/acme/app".to_string())).unwrap_err();

        assert_eq!(error.reason, "invalid state: in use by box b1");
    }
}
