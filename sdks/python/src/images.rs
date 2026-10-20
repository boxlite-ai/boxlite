use crate::registries::PyRegistryHandle;
use std::sync::Arc;

use boxlite::ImageHandle;
use boxlite::runtime::types::{ImageAliasEvent, ImageDetail, ImageInfo, ImageUsage, ImageVersion};
use pyo3::prelude::*;

use crate::util::map_err;

#[pyclass(name = "ImageInfo")]
#[derive(Clone)]
pub(crate) struct PyImageInfo {
    #[pyo3(get)]
    pub(crate) reference: String,
    #[pyo3(get)]
    pub(crate) repository: String,
    #[pyo3(get)]
    pub(crate) tag: String,
    #[pyo3(get)]
    pub(crate) id: String,
    #[pyo3(get)]
    pub(crate) cached_at: String,
    #[pyo3(get)]
    pub(crate) size_bytes: Option<u64>,
}

#[pymethods]
impl PyImageInfo {
    fn __repr__(&self) -> String {
        format!(
            "ImageInfo(reference={:?}, id={:?}, cached_at={:?})",
            self.reference, self.id, self.cached_at
        )
    }
}

impl From<ImageInfo> for PyImageInfo {
    fn from(info: ImageInfo) -> Self {
        Self {
            reference: info.reference,
            repository: info.repository,
            tag: info.tag,
            id: info.id,
            cached_at: info.cached_at.to_rfc3339(),
            size_bytes: info.size.map(|size| size.as_bytes()),
        }
    }
}

#[pyclass(name = "ImagePullResult")]
#[derive(Clone)]
pub(crate) struct PyImagePullResult {
    #[pyo3(get)]
    pub(crate) reference: String,
    #[pyo3(get)]
    pub(crate) config_digest: String,
    #[pyo3(get)]
    pub(crate) layer_count: usize,
}

#[pymethods]
impl PyImagePullResult {
    fn __repr__(&self) -> String {
        format!(
            "ImagePullResult(reference={:?}, config_digest={:?}, layer_count={})",
            self.reference, self.config_digest, self.layer_count
        )
    }
}

/// One build of an image.
#[pyclass(name = "ImageVersion")]
#[derive(Clone)]
pub(crate) struct PyImageVersion {
    #[pyo3(get)]
    pub(crate) digest: String,
    #[pyo3(get)]
    pub(crate) size_bytes: Option<u64>,
    #[pyo3(get)]
    pub(crate) source_ref: String,
    #[pyo3(get)]
    pub(crate) recorded_at: String,
    #[pyo3(get)]
    pub(crate) aliases: Vec<String>,
    #[pyo3(get)]
    pub(crate) last_used_at: Option<String>,
    #[pyo3(get)]
    pub(crate) upstream_missing_at: Option<String>,
}

#[pymethods]
impl PyImageVersion {
    fn __repr__(&self) -> String {
        format!(
            "ImageVersion(digest={:?}, source_ref={:?})",
            self.digest, self.source_ref
        )
    }
}

impl From<ImageVersion> for PyImageVersion {
    fn from(version: ImageVersion) -> Self {
        Self {
            digest: version.digest,
            size_bytes: version.size_bytes,
            source_ref: version.source_ref,
            recorded_at: version.recorded_at.to_rfc3339(),
            aliases: version.aliases,
            last_used_at: version.last_used_at.map(|time| time.to_rfc3339()),
            upstream_missing_at: version.upstream_missing_at.map(|time| time.to_rfc3339()),
        }
    }
}

/// An alias registration or historical binding change; versions named by digest.
#[pyclass(name = "ImageAliasEvent")]
#[derive(Clone)]
pub(crate) struct PyImageAliasEvent {
    #[pyo3(get)]
    pub(crate) alias: String,
    #[pyo3(get)]
    pub(crate) from_digest: Option<String>,
    #[pyo3(get)]
    pub(crate) to_digest: String,
    #[pyo3(get)]
    pub(crate) actor: Option<String>,
    #[pyo3(get)]
    pub(crate) recorded_at: String,
}

#[pymethods]
impl PyImageAliasEvent {
    fn __repr__(&self) -> String {
        format!(
            "ImageAliasEvent(alias={:?}, from_digest={:?}, to_digest={:?})",
            self.alias, self.from_digest, self.to_digest
        )
    }
}

impl From<ImageAliasEvent> for PyImageAliasEvent {
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

/// An image name and every build held under it.
#[pyclass(name = "ImageDetail")]
#[derive(Clone)]
pub(crate) struct PyImageDetail {
    #[pyo3(get)]
    pub(crate) name: String,
    #[pyo3(get)]
    pub(crate) aliases: Vec<String>,
    #[pyo3(get)]
    pub(crate) curated: bool,
    #[pyo3(get)]
    pub(crate) versions: Vec<PyImageVersion>,
    #[pyo3(get)]
    pub(crate) history: Vec<PyImageAliasEvent>,
}

#[pymethods]
impl PyImageDetail {
    fn __repr__(&self) -> String {
        format!(
            "ImageDetail(name={:?}, aliases={:?}, versions={})",
            self.name,
            self.aliases,
            self.versions.len()
        )
    }
}

impl From<ImageDetail> for PyImageDetail {
    fn from(detail: ImageDetail) -> Self {
        Self {
            name: detail.name,
            aliases: detail.aliases,
            curated: detail.curated,
            versions: detail
                .versions
                .into_iter()
                .map(PyImageVersion::from)
                .collect(),
            history: detail
                .history
                .into_iter()
                .map(PyImageAliasEvent::from)
                .collect(),
        }
    }
}

/// Images held against the allowance, on a REST runtime.
#[pyclass(name = "ImageUsage")]
#[derive(Clone)]
pub(crate) struct PyImageUsage {
    #[pyo3(get)]
    pub(crate) count: u64,
    #[pyo3(get)]
    pub(crate) limit: u64,
    #[pyo3(get)]
    pub(crate) known_bytes: u64,
}

#[pymethods]
impl PyImageUsage {
    fn __repr__(&self) -> String {
        format!(
            "ImageUsage(count={}, limit={}, known_bytes={})",
            self.count, self.limit, self.known_bytes
        )
    }
}

impl From<ImageUsage> for PyImageUsage {
    fn from(usage: ImageUsage) -> Self {
        Self {
            count: usage.count,
            limit: usage.limit,
            known_bytes: usage.known_bytes,
        }
    }
}

#[pyclass(name = "ImageHandle")]
pub(crate) struct PyImageHandle {
    pub(crate) handle: Arc<ImageHandle>,
}

#[pymethods]
impl PyImageHandle {
    fn pull<'py>(&self, py: Python<'py>, reference: String) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let image = handle.pull(&reference).await.map_err(map_err)?;
            Ok(PyImagePullResult {
                reference: image.reference().to_string(),
                config_digest: image.config_digest().to_string(),
                layer_count: image.layer_count(),
            })
        })
    }

    /// The server's registry logins (list, create, remove).
    ///
    /// Raises UnsupportedError on a local runtime, which pulls with the
    /// logins in `Options(image_registries=...)` instead.
    #[getter]
    fn registries(&self) -> PyResult<PyRegistryHandle> {
        let handle = self.handle.registries().map_err(map_err)?;
        Ok(PyRegistryHandle {
            handle: Arc::new(handle),
        })
    }

    fn list<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let infos = handle.list().await.map_err(map_err)?;
            Ok(infos.into_iter().map(PyImageInfo::from).collect::<Vec<_>>())
        })
    }

    /// Every build held under an image name, such as "docker.io/library/alpine".
    fn get<'py>(&self, py: Python<'py>, name: String) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let detail = handle.get(&name).await.map_err(map_err)?;
            Ok(PyImageDetail::from(detail))
        })
    }

    /// Stop holding an image name, every tag of it.
    fn remove<'py>(&self, py: Python<'py>, name: String) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle.remove(&name).await.map_err(map_err)?;
            Ok(())
        })
    }

    /// Images held against the allowance; REST runtimes only.
    fn usage<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let usage = handle.usage().await.map_err(map_err)?;
            Ok(PyImageUsage::from(usage))
        })
    }

    /// Create a catalog alias for a ready version, refusing an existing alias; REST
    /// runtimes only.
    fn create_alias<'py>(
        &self,
        py: Python<'py>,
        name: String,
        alias: String,
        digest: String,
    ) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let detail = handle
                .create_alias(&name, &alias, &digest)
                .await
                .map_err(map_err)?;
            Ok(PyImageDetail::from(detail))
        })
    }

    /// Delete only a catalog alias; REST runtimes only.
    fn delete_alias<'py>(
        &self,
        py: Python<'py>,
        name: String,
        alias: String,
    ) -> PyResult<Bound<'py, PyAny>> {
        let handle = Arc::clone(&self.handle);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            handle.delete_alias(&name, &alias).await.map_err(map_err)
        })
    }

    fn __repr__(&self) -> String {
        "ImageHandle()".to_string()
    }
}

#[cfg(test)]
mod tests {
    use std::ffi::CString;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::thread::{self, JoinHandle};
    use std::time::{Duration, SystemTime};

    use boxlite::{BoxliteRestOptions, BoxliteRuntime};
    use pyo3::types::PyDict;

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

    fn detail(versions: Vec<ImageVersion>) -> ImageDetail {
        ImageDetail {
            name: "quay.io/acme/app".to_string(),
            aliases: vec!["v2".to_string(), "v1".to_string()],
            curated: true,
            versions,
            history: Vec::new(),
        }
    }

    #[test]
    fn image_detail_keeps_every_version_newest_first() {
        let detail = PyImageDetail::from(detail(vec![
            version("sha256:bb", Some(4096), 2),
            version("sha256:aa", None, 1),
        ]));

        assert_eq!(detail.name, "quay.io/acme/app");
        assert_eq!(detail.aliases, ["v2", "v1"]);
        assert!(detail.curated);
        let [newest, oldest] = detail.versions.as_slice() else {
            panic!("expected two versions, got {}", detail.versions.len());
        };
        assert_eq!(newest.digest, "sha256:bb");
        assert_eq!(newest.size_bytes, Some(4096));
        assert_eq!(newest.source_ref, "quay.io/acme/app@sha256:bb");
        assert_eq!(newest.recorded_at, "1970-01-01T00:00:02+00:00");
        assert_eq!(oldest.digest, "sha256:aa");
        assert_eq!(oldest.size_bytes, None);
    }

    /// Python ints are unbounded, so unlike the Node binding nothing here
    /// saturates: the full u64 range reaches Python as it was reported.
    #[test]
    fn usage_and_sizes_keep_the_full_u64_range() {
        let usage = PyImageUsage::from(ImageUsage {
            count: 3,
            limit: 20,
            known_bytes: u64::MAX,
        });
        assert_eq!(
            (usage.count, usage.limit, usage.known_bytes),
            (3, 20, u64::MAX)
        );

        let version = PyImageVersion::from(version("sha256:aa", Some(u64::MAX), 0));
        assert_eq!(version.size_bytes, Some(u64::MAX));
    }

    /// A detail's repr counts its builds rather than printing every one.
    #[test]
    fn reprs_name_the_image_without_listing_every_build() {
        let detail = PyImageDetail::from(detail(vec![
            version("sha256:bb", Some(4096), 2),
            version("sha256:aa", None, 1),
        ]));
        let newest = detail.versions[0].clone();
        let usage = PyImageUsage::from(ImageUsage {
            count: 3,
            limit: 20,
            known_bytes: 4096,
        });

        Python::attach(|py| {
            let repr = |object: Bound<'_, PyAny>| object.repr().unwrap().to_string();
            assert_eq!(
                repr(Bound::new(py, detail).unwrap().into_any()),
                r#"ImageDetail(name="quay.io/acme/app", aliases=["v2", "v1"], versions=2)"#
            );
            assert_eq!(
                repr(Bound::new(py, newest).unwrap().into_any()),
                r#"ImageVersion(digest="sha256:bb", source_ref="quay.io/acme/app@sha256:bb")"#
            );
            assert_eq!(
                repr(Bound::new(py, usage).unwrap().into_any()),
                "ImageUsage(count=3, limit=20, known_bytes=4096)"
            );
        });
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

    fn images_at(py: Python<'_>, url: String) -> Bound<'_, PyImageHandle> {
        let runtime = BoxliteRuntime::rest(BoxliteRestOptions::new(url)).unwrap();
        let handle = PyImageHandle {
            handle: Arc::new(runtime.images().unwrap()),
        };
        Bound::new(py, handle).unwrap()
    }

    /// Runs `await images.<call>` on a new event loop, the way Python code
    /// awaits `runtime.images.<call>`.
    fn awaited<'py>(images: &Bound<'py, PyImageHandle>, call: &str) -> Bound<'py, PyAny> {
        let py = images.py();
        let globals = PyDict::new(py);
        globals.set_item("images", images).unwrap();
        let script = CString::new(format!(
            "import asyncio\n\nasync def main():\n    return await images.{call}\n\nresult = asyncio.run(main())\n"
        ))
        .unwrap();
        py.run(&script, Some(&globals), None).unwrap();
        globals.get_item("result").unwrap().unwrap()
    }

    #[test]
    fn get_reads_the_name_and_its_versions_from_a_rest_server() {
        let (url, server) = http_server(vec![(
            200,
            r#"{"name":"quay.io/acme/app","aliases":["v1"],"curated":false,"versions":[{"digest":"sha256:aa","size_bytes":42,"source_ref":"quay.io/acme/app:v1","recorded_at":"2026-01-02T03:04:05Z"}]}"#,
        )]);

        Python::attach(|py| {
            let detail = awaited(&images_at(py, url), r#"get("quay.io/acme/app")"#);

            assert_eq!(
                server.join().unwrap(),
                ["GET /v1/images/quay.io%2Facme%2Fapp HTTP/1.1"]
            );
            let (name, aliases, curated): (String, Vec<String>, bool) = (
                detail.getattr("name").unwrap().extract().unwrap(),
                detail.getattr("aliases").unwrap().extract().unwrap(),
                detail.getattr("curated").unwrap().extract().unwrap(),
            );
            assert_eq!(
                (name.as_str(), aliases, curated),
                ("quay.io/acme/app", vec!["v1".to_string()], false)
            );
            let version = detail.getattr("versions").unwrap().get_item(0).unwrap();
            let read = |field: &str| version.getattr(field).unwrap();
            let size_bytes: Option<u64> = read("size_bytes").extract().unwrap();
            assert_eq!(size_bytes, Some(42));
            let [digest, source_ref, recorded_at]: [String; 3] =
                ["digest", "source_ref", "recorded_at"].map(|field| read(field).extract().unwrap());
            assert_eq!(digest, "sha256:aa");
            assert_eq!(source_ref, "quay.io/acme/app:v1");
            assert_eq!(recorded_at, "2026-01-02T03:04:05+00:00");
        });
    }

    #[test]
    fn remove_deletes_the_name_on_a_rest_server() {
        let (url, server) = http_server(vec![(204, "")]);

        Python::attach(|py| {
            awaited(&images_at(py, url), r#"remove("quay.io/acme/app")"#);

            assert_eq!(
                server.join().unwrap(),
                ["DELETE /v1/images/quay.io%2Facme%2Fapp HTTP/1.1"]
            );
        });
    }

    #[test]
    fn usage_reads_count_limit_and_bytes_from_a_rest_server() {
        let (url, server) =
            http_server(vec![(200, r#"{"count":3,"limit":20,"known_bytes":4096}"#)]);

        Python::attach(|py| {
            let usage = awaited(&images_at(py, url), "usage()");

            assert_eq!(server.join().unwrap(), ["GET /v1/images/usage HTTP/1.1"]);
            let read = |field: &str| usage.getattr(field).unwrap().extract::<u64>().unwrap();
            assert_eq!(
                (read("count"), read("limit"), read("known_bytes")),
                (3, 20, 4096)
            );
        });
    }
}
