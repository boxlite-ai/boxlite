//! Streaming file copy: move an archive in or out without a file on either
//! side.
//!
//! The path-based [`crate::box_handle::PyBox::copy_in`] pair is still the
//! answer for "copy this file into the box". These two are for bytes that have
//! no path — a payload built in memory, a download being relayed, a tar the
//! caller pipes through — and they mirror the shape the C and Go SDKs already
//! expose.

use std::sync::Arc;

use pyo3::types::PyBytes;
use pyo3::{Bound, Py, PyAny, PyRef, PyResult, Python, pyclass, pymethods};
use tokio::sync::{Mutex, mpsc};

use crate::util::map_err;

/// In-flight chunks a writer may run ahead of the upload.
///
/// The same window the C ABI's copy-in stream uses: bounded, so a producer
/// faster than the guest is slowed down rather than buffered without limit.
const WRITE_WINDOW: usize = 4;

/// The writer half of a copy-in: `None` once the archive has been ended.
type ChunkSender = Arc<Mutex<Option<mpsc::Sender<std::io::Result<Vec<u8>>>>>>;

/// The copy running behind a writer, joined by `close`/`abort`.
type UploadTask = Arc<Mutex<Option<tokio::task::JoinHandle<boxlite::BoxliteResult<()>>>>>;

/// Set by `close` to mean "the archive really ended here".
///
/// Dropping the writer drops the last `Sender`, which ends the channel as
/// *cleanly* as a `close` would — and a tar cut on a block boundary extracts
/// without complaint, so an abandoned copy would otherwise be reported as a
/// successful one. The consumer reads this once the channel is exhausted and
/// turns an unmarked end into a terminal error.
type ArchiveEnded = Arc<std::sync::atomic::AtomicBool>;

/// An archive being read out of a box, chunk by chunk.
///
/// Async-iterable: `async for chunk in stream`.
#[pyclass(name = "CopyOutStream")]
pub(crate) struct PyCopyOutStream {
    stream: Arc<Mutex<boxlite::BoxByteStream>>,
    source_is_dir: Option<bool>,
}

impl PyCopyOutStream {
    pub(crate) fn new(stream: boxlite::BoxByteStream, source: boxlite::CopySourceKind) -> Self {
        Self {
            stream: Arc::new(Mutex::new(stream)),
            source_is_dir: source.to_wire(),
        }
    }
}

#[pymethods]
impl PyCopyOutStream {
    /// Shape of what was archived: `True` for a directory tree, `False` for a
    /// single file, `None` when the box could not tell (an older guest), in
    /// which case the archive itself is the only source of truth.
    #[getter]
    fn source_is_dir(&self) -> Option<bool> {
        self.source_is_dir
    }

    fn __aiter__(slf: PyRef<'_, Self>) -> PyRef<'_, Self> {
        slf
    }

    fn __anext__<'a>(&self, py: Python<'a>) -> PyResult<Option<Bound<'a, PyAny>>> {
        let stream = Arc::clone(&self.stream);

        let future = pyo3_async_runtimes::tokio::future_into_py(py, async move {
            use futures::StreamExt;
            let mut guard = stream.lock().await;
            match guard.next().await {
                Some(Ok(chunk)) => Python::attach(|py| Ok(PyBytes::new(py, &chunk).unbind())),
                // A terminal error, not an end: raising here is what stops a
                // caller from treating a severed transfer as a whole archive.
                Some(Err(e)) => Err(pyo3::exceptions::PyIOError::new_err(e.to_string())),
                None => Err(pyo3::exceptions::PyStopAsyncIteration::new_err("")),
            }
        })?;

        Ok(Some(future))
    }

    fn __repr__(&self) -> String {
        format!("CopyOutStream(source_is_dir={:?})", self.source_is_dir)
    }
}

/// An archive being written into a box, chunk by chunk.
///
/// The upload runs while chunks are written, so a failure on either side —
/// the guest refusing the destination, or the caller aborting — surfaces from
/// [`Self::close`].
///
/// A writer abandoned without [`Self::close`] has its copy *reported as
/// failed*: only `close` marks the archive as ended, and an unmarked end
/// reaches the box as an error rather than an EOF it would extract happily.
/// Bytes the box already wrote can still be on its filesystem — that is true
/// of any mid-stream failure on the streamed path — so the guarantee is "no
/// silent success", not "nothing landed". `__aexit__` closes on the way out,
/// and aborts if the body raised.
#[pyclass(name = "CopyInStream")]
pub(crate) struct PyCopyInStream {
    chunks: ChunkSender,
    upload: UploadTask,
    ended: ArchiveEnded,
}

#[pymethods]
impl PyCopyInStream {
    /// Hand the next chunk to the upload, waiting if it is already
    /// [`WRITE_WINDOW`] chunks ahead.
    fn write<'a>(&self, py: Python<'a>, data: Vec<u8>) -> PyResult<Bound<'a, PyAny>> {
        let chunks = Arc::clone(&self.chunks);
        let upload = Arc::clone(&self.upload);

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let sent = {
                let guard = chunks.lock().await;
                let Some(sender) = guard.as_ref() else {
                    return Err(pyo3::exceptions::PyValueError::new_err("write after close"));
                };
                sender.send(Ok(data)).await
            };
            if sent.is_ok() {
                return Ok(());
            }
            // The upload ended before this chunk, and its own error is the
            // real reason — a refused destination, a failed extraction. Raise
            // that instead of the send failure, which only says the channel is
            // gone. Without this the reason is lost for good: the caller
            // aborts on the write error and `abort` discards the copy's
            // result, so only archives small enough to fit the write window
            // ever reach `close`.
            join_upload(upload).await?;
            Err(pyo3::exceptions::PyIOError::new_err(
                "the copy ended before this chunk",
            ))
        })
    }

    /// Signal end of archive and wait for the box to finish extracting it.
    ///
    /// This is where a refused destination or a failed extraction is raised —
    /// the writes before it only queue bytes.
    fn close<'a>(&self, py: Python<'a>) -> PyResult<Bound<'a, PyAny>> {
        let chunks = Arc::clone(&self.chunks);
        let upload = Arc::clone(&self.upload);
        let ended = Arc::clone(&self.ended);

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            // Marked *before* the sender goes, so the consumer cannot reach
            // the exhausted channel while the flag still says otherwise.
            ended.store(true, std::sync::atomic::Ordering::SeqCst);
            drop(chunks.lock().await.take());
            join_upload(upload).await
        })
    }

    /// Fail the copy instead of finishing it.
    ///
    /// The box sees a terminal error rather than a clean end, so a truncated
    /// archive cannot be mistaken for a whole one. Returns normally — the
    /// caller is already handling whatever made them abort.
    fn abort<'a>(&self, py: Python<'a>) -> PyResult<Bound<'a, PyAny>> {
        let chunks = Arc::clone(&self.chunks);
        let upload = Arc::clone(&self.upload);

        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            if let Some(sender) = chunks.lock().await.take() {
                let _ = sender
                    .send(Err(std::io::Error::new(
                        std::io::ErrorKind::BrokenPipe,
                        "copy aborted by the caller",
                    )))
                    .await;
            }
            let _ = join_upload(upload).await;
            Ok(())
        })
    }

    fn __aenter__<'a>(slf: PyRef<'_, Self>, py: Python<'a>) -> PyResult<Bound<'a, PyAny>> {
        let handle: Py<Self> = slf.into();
        pyo3_async_runtimes::tokio::future_into_py(py, async move { Ok(handle) })
    }

    #[pyo3(signature = (exc_type=None, exc_value=None, traceback=None))]
    fn __aexit__<'a>(
        &self,
        py: Python<'a>,
        exc_type: Option<Bound<'a, PyAny>>,
        exc_value: Option<Bound<'a, PyAny>>,
        traceback: Option<Bound<'a, PyAny>>,
    ) -> PyResult<Bound<'a, PyAny>> {
        let _ = (exc_value, traceback);
        // An exception on the way out means the archive is incomplete, so the
        // copy must fail rather than commit what did arrive.
        if exc_type.is_some() {
            self.abort(py)
        } else {
            self.close(py)
        }
    }

    fn __repr__(&self) -> String {
        "CopyInStream(...)".to_string()
    }
}

/// Wait for the upload task, flattening "the task died" and "the copy failed".
async fn join_upload(upload: UploadTask) -> PyResult<()> {
    let Some(task) = upload.lock().await.take() else {
        // Already awaited: closing twice is not an error.
        return Ok(());
    };
    task.await
        .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("copy task failed: {e}")))?
        .map_err(map_err)
}

/// Start an upload and hand back the writer for it.
///
/// Lives here rather than on `PyBox` so the channel, the spawned upload and
/// the handle that feeds it are created in one place.
pub(crate) fn start_copy_in(
    handle: Arc<boxlite::LiteBox>,
    container_dest: String,
    source: boxlite::CopySourceKind,
    opts: boxlite::CopyOptions,
) -> PyCopyInStream {
    let (tx, rx) = mpsc::channel::<std::io::Result<Vec<u8>>>(WRITE_WINDOW);
    let ended: ArchiveEnded = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let marker = Arc::clone(&ended);
    let chunks = futures::stream::unfold(Some(rx), move |state| {
        let marker = Arc::clone(&marker);
        async move {
            let mut rx = state?;
            match rx.recv().await {
                Some(item) => Some((item, Some(rx))),
                // Channel exhausted. Only `close` marks the archive as ended;
                // anything else got here by dropping the writer, and must not
                // look like a whole archive.
                None if marker.load(std::sync::atomic::Ordering::SeqCst) => None,
                None => Some((
                    Err(std::io::Error::new(
                        std::io::ErrorKind::BrokenPipe,
                        "copy stream dropped without close()",
                    )),
                    None,
                )),
            }
        }
    });
    let upload = pyo3_async_runtimes::tokio::get_runtime().spawn(async move {
        handle
            .copy_in_stream(chunks, &container_dest, source, opts)
            .await
    });

    PyCopyInStream {
        chunks: Arc::new(Mutex::new(Some(tx))),
        upload: Arc::new(Mutex::new(Some(upload))),
        ended,
    }
}

#[cfg(test)]
mod tests {
    //! The pymethods are driven by Python code under an embedded interpreter,
    //! the way the wheel's users drive them: `future_into_py` needs a running
    //! asyncio loop, and `asyncio.run` provides one. Everything asserted on is
    //! then read back from the fake upstream or from what the snippet
    //! recorded, so each assertion is about something that crossed a boundary.

    use super::*;
    use crate::test_support::{Download, FakeUpstream, Upload, run_python};
    use pyo3::prelude::*;
    use pyo3::types::{PyBytes, PyDict};

    /// `boxlite` (the module), `box` (a handle onto the fake's box) and a
    /// `results` dict for the snippet to write into.
    fn namespace<'py>(py: Python<'py>, fake: &FakeUpstream) -> Bound<'py, PyDict> {
        let namespace = PyDict::new(py);
        namespace
            .set_item("boxlite", crate::test_module(py))
            .expect("module");
        let handle = crate::box_handle::PyBox {
            handle: fake.litebox(),
        };
        namespace
            .set_item("box", Py::new(py, handle).expect("box"))
            .expect("box");
        namespace
            .set_item("results", PyDict::new(py))
            .expect("results");
        namespace
    }

    fn result<'py>(namespace: &Bound<'py, PyDict>, key: &str) -> Bound<'py, PyAny> {
        namespace
            .get_item("results")
            .expect("results lookup")
            .expect("results dict")
            .cast_into::<PyDict>()
            .expect("results is a dict")
            .get_item(key)
            .expect("result lookup")
            .unwrap_or_else(|| panic!("the snippet recorded no {key}"))
    }

    fn header<'a>(upload: &'a Upload, name: &str) -> Option<&'a str> {
        upload
            .headers
            .iter()
            .find(|(header, _)| header == name)
            .map(|(_, value)| value.as_str())
    }

    #[test]
    fn a_closed_writer_delivers_every_chunk_to_the_upstream_in_order() {
        let fake = FakeUpstream::start(None);
        Python::attach(|py| {
            let namespace = namespace(py, &fake);
            run_python(
                py,
                &namespace,
                r#"
stream = box.copy_in_stream("/dest/file", False, boxlite.CopyOptions())
assert repr(stream) == "CopyInStream(...)"
for chunk in (b"head", b"x" * 65536, b"tail"):
    await stream.write(chunk)
await stream.close()
"#,
            )
            .expect("python");
        });

        let upload = fake.wait_for_uploads(1).remove(0);
        assert_eq!(
            upload.path_and_query,
            "/v1/boxes/box1/files?path=%2Fdest%2Ffile&source_is_dir=false"
        );
        assert_eq!(header(&upload, "content-type"), Some("application/x-tar"));
        assert_eq!(header(&upload, "transfer-encoding"), Some("chunked"));
        let mut expected = b"head".to_vec();
        expected.extend(std::iter::repeat_n(b'x', 65536));
        expected.extend_from_slice(b"tail");
        assert_eq!(upload.body, expected);
        assert!(upload.terminated, "close must end the archive cleanly");
    }

    #[test]
    fn the_async_context_manager_closes_on_success_and_aborts_on_error() {
        let fake = FakeUpstream::start(None);
        Python::attach(|py| {
            let namespace = namespace(py, &fake);
            run_python(
                py,
                &namespace,
                r#"
async with box.copy_in_stream("/dest/ok", False, boxlite.CopyOptions()) as stream:
    await stream.write(b"payload")
try:
    async with box.copy_in_stream("/dest/broken", False, boxlite.CopyOptions()) as stream:
        await stream.write(b"partial")
        raise ValueError("the caller gave up")
except ValueError:
    results["reraised"] = True
"#,
            )
            .expect("python");
            assert!(
                result(&namespace, "reraised")
                    .extract::<bool>()
                    .expect("bool"),
                "__aexit__ must let the caller's exception through"
            );
        });

        let uploads = fake.wait_for_uploads(2);
        let ok = uploads
            .iter()
            .find(|upload| upload.path_and_query.contains("%2Fdest%2Fok"))
            .expect("the clean upload");
        assert_eq!(ok.body, b"payload");
        assert!(ok.terminated, "leaving the block normally closes");
        let broken = uploads
            .iter()
            .find(|upload| upload.path_and_query.contains("%2Fdest%2Fbroken"))
            .expect("the aborted upload");
        assert!(
            !broken.terminated,
            "leaving the block with an exception aborts: the upstream must not see a whole archive"
        );
    }

    #[test]
    fn dropping_the_writer_without_close_fails_the_upload_instead_of_ending_it() {
        let fake = FakeUpstream::start(None);
        let handle = fake.litebox();
        let upload = Python::attach(|py| {
            let stream = start_copy_in(
                handle,
                "/dest/dropped".to_owned(),
                boxlite::CopySourceKind::File,
                boxlite::CopyOptions::default(),
            );
            let upload = Arc::clone(&stream.upload);
            let namespace = PyDict::new(py);
            namespace
                .set_item("stream", Py::new(py, stream).expect("stream"))
                .expect("stream");
            run_python(py, &namespace, "await stream.write(b'partial')").expect("python");
            // The namespace held the only reference: this is the drop.
            namespace.del_item("stream").expect("drop the writer");
            upload
        });

        let outcome = pyo3_async_runtimes::tokio::get_runtime().block_on(join_upload(upload));
        assert!(
            outcome.is_err(),
            "an archive that merely stopped arriving must not be reported whole"
        );
        let upload = fake.wait_for_uploads(1).remove(0);
        assert!(
            !upload.terminated,
            "the upstream must see a severed body, not a clean end"
        );
    }

    #[test]
    fn a_write_after_the_copy_died_reports_the_copys_own_reason() {
        let fake = FakeUpstream::start(None);
        Python::attach(|py| {
            let namespace = namespace(py, &fake);
            run_python(
                py,
                &namespace,
                r#"
stream = box.copy_in_stream("/dest/tree", True, boxlite.CopyOptions(recursive=False))
try:
    for _ in range(16):
        await stream.write(b"x")
    results["error"] = "no error raised"
except Exception as e:
    results["error"] = f"{type(e).__name__}: {e}"
"#,
            )
            .expect("python");
            let error = result(&namespace, "error")
                .extract::<String>()
                .expect("error");
            assert!(
                error.contains("recursive=false not supported for directory copies"),
                "{error}"
            );
            assert!(
                !error.contains("the copy ended before this chunk"),
                "the channel closing is not the reason: {error}"
            );
        });
        assert!(
            fake.recorded().uploads.is_empty(),
            "refused before a request was sent"
        );
    }

    #[test]
    fn close_surfaces_a_refusal_the_core_raises_before_a_byte_is_sent() {
        let fake = FakeUpstream::start(None);
        Python::attach(|py| {
            let namespace = namespace(py, &fake);
            run_python(
                py,
                &namespace,
                r#"
stream = box.copy_in_stream("/dest/file", False, boxlite.CopyOptions(overwrite=False))
try:
    await stream.close()
    results["error"] = "no error raised"
except Exception as e:
    results["error"] = f"{type(e).__name__}: {e}"
"#,
            )
            .expect("python");
            let error = result(&namespace, "error")
                .extract::<String>()
                .expect("error");
            assert!(
                error.starts_with("RuntimeError: ") && error.contains("overwrite=false"),
                "{error}"
            );
        });
        assert!(fake.recorded().uploads.is_empty());
    }

    #[test]
    fn a_write_after_close_is_refused() {
        let fake = FakeUpstream::start(None);
        Python::attach(|py| {
            let namespace = namespace(py, &fake);
            run_python(
                py,
                &namespace,
                r#"
stream = box.copy_in_stream("/dest/file", False, boxlite.CopyOptions())
await stream.close()
try:
    await stream.write(b"late")
    results["error"] = "no error raised"
except ValueError as e:
    results["error"] = str(e)
"#,
            )
            .expect("python");
            assert_eq!(
                result(&namespace, "error")
                    .extract::<String>()
                    .expect("error"),
                "write after close"
            );
        });
    }

    #[test]
    fn copy_out_stream_carries_the_shape_and_the_bytes() {
        for source_is_dir in [Some(true), Some(false), None] {
            let fake = FakeUpstream::start(Some(Download {
                source_is_dir,
                body: b"tar-bytes".to_vec(),
                truncate: false,
            }));
            Python::attach(|py| {
                let namespace = namespace(py, &fake);
                run_python(
                    py,
                    &namespace,
                    r#"
stream = await box.copy_out_stream("/src")
results["shape"] = stream.source_is_dir
results["repr"] = repr(stream)
results["body"] = b"".join([chunk async for chunk in stream])
"#,
                )
                .expect("python");
                assert_eq!(
                    result(&namespace, "shape")
                        .extract::<Option<bool>>()
                        .expect("shape"),
                    source_is_dir,
                    "the header is reported verbatim, absence included"
                );
                assert!(
                    result(&namespace, "repr")
                        .extract::<String>()
                        .expect("repr")
                        .starts_with("CopyOutStream(")
                );
                assert_eq!(
                    result(&namespace, "body")
                        .cast_into::<PyBytes>()
                        .expect("bytes")
                        .as_bytes(),
                    b"tar-bytes"
                );
            });
            let requests = fake.recorded().requests;
            assert!(
                requests
                    .iter()
                    .any(|line| line.starts_with("GET /v1/boxes/box1/files?path=%2Fsrc")),
                "{requests:?}"
            );
        }
    }

    #[test]
    fn a_severed_download_raises_instead_of_ending_cleanly() {
        let fake = FakeUpstream::start(Some(Download {
            source_is_dir: Some(false),
            body: b"first".to_vec(),
            truncate: true,
        }));
        Python::attach(|py| {
            let namespace = namespace(py, &fake);
            run_python(
                py,
                &namespace,
                r#"
stream = await box.copy_out_stream("/src")
try:
    b"".join([chunk async for chunk in stream])
    results["error"] = "no error raised"
except OSError as e:
    results["error"] = str(e)
"#,
            )
            .expect("python");
            let error = result(&namespace, "error")
                .extract::<String>()
                .expect("error");
            assert!(
                error.contains("response decode failed"),
                "a cut body must surface as the transport fault, got: {error}"
            );
        });
    }
}
