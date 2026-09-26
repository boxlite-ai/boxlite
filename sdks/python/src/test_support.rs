//! An in-process REST upstream for the binding's own tests.
//!
//! `LiteBox::new` is private to the core crate, so the only way to hold a
//! `LiteBox` from here is a REST runtime pointed at a server we control. Raw
//! TCP and hand-written HTTP/1.1, as in the core crate's own REST tests, keep
//! the fake free of new dependencies.

use std::ffi::CString;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use pyo3::prelude::*;
use pyo3::types::PyDict;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

/// The one box the upstream knows.
pub(crate) const BOX_ID: &str = "box1";

/// What `GET /v1/boxes/{id}` answers: every field `BoxResponse` requires.
const BOX_JSON: &str = r#"{"box_id":"box1","name":null,"status":"running","created_at":"2026-07-14T00:00:00Z","updated_at":"2026-07-14T00:00:00Z","pid":null,"image":"alpine:latest","cpus":1,"memory_mib":512}"#;

/// One PUT to `/files`, as the upstream saw it.
#[derive(Debug, Clone)]
pub(crate) struct Upload {
    pub path_and_query: String,
    /// Header names lower-cased.
    pub headers: Vec<(String, String)>,
    /// The body with the chunked framing removed.
    pub body: Vec<u8>,
    /// Whether the client sent the terminating chunk. A client that hung up
    /// mid-body leaves this false — the difference between an archive and
    /// a severed one.
    pub terminated: bool,
}

#[derive(Debug, Default, Clone)]
pub(crate) struct Recorded {
    /// Request lines, in arrival order.
    pub requests: Vec<String>,
    pub uploads: Vec<Upload>,
}

/// How the upstream answers `GET /files`.
#[derive(Clone)]
pub(crate) struct Download {
    pub source_is_dir: Option<bool>,
    pub body: Vec<u8>,
    /// Promise more bytes than are sent, then close: a severed download.
    pub truncate: bool,
}

type Sink = Arc<(Mutex<Recorded>, Condvar)>;

pub(crate) struct FakeUpstream {
    port: u16,
    recorded: Sink,
    /// Drives the accept loop on its own threads. The test thread is busy
    /// inside `asyncio.run` under the GIL, and the copies run on
    /// pyo3-async-runtimes' runtime, so neither can be asked to poll this.
    runtime: tokio::runtime::Runtime,
}

impl FakeUpstream {
    pub(crate) fn start(download: Option<Download>) -> Self {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("fake upstream runtime");
        let listener = runtime
            .block_on(TcpListener::bind("127.0.0.1:0"))
            .expect("bind fake upstream");
        let port = listener.local_addr().expect("fake upstream address").port();
        let recorded: Sink = Arc::default();
        let sink = Arc::clone(&recorded);
        runtime.spawn(async move {
            while let Ok((socket, _)) = listener.accept().await {
                let download = download.clone();
                let sink = Arc::clone(&sink);
                tokio::spawn(async move {
                    let _ = serve(socket, download, sink).await;
                });
            }
        });
        Self {
            port,
            recorded,
            runtime,
        }
    }

    pub(crate) fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// The `LiteBox` a REST runtime hands out for the fake's box: a `RestBox`
    /// behind the same facade the wheel drives.
    pub(crate) fn litebox(&self) -> Arc<boxlite::LiteBox> {
        let handle = self.runtime.block_on(async {
            let runtime =
                boxlite::BoxliteRuntime::rest(boxlite::BoxliteRestOptions::new(self.url()))
                    .expect("rest runtime");
            runtime
                .get(BOX_ID)
                .await
                .expect("GET /v1/boxes/box1")
                .expect("the fake serves box1")
        });
        Arc::new(handle)
    }

    pub(crate) fn recorded(&self) -> Recorded {
        self.recorded.0.lock().expect("recorded").clone()
    }

    /// Uploads land in the sink once the server side of the connection has
    /// seen them end, which is after the client moved on — so wait for them.
    pub(crate) fn wait_for_uploads(&self, count: usize) -> Vec<Upload> {
        let (lock, changed) = &*self.recorded;
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut recorded = lock.lock().expect("recorded");
        while recorded.uploads.len() < count {
            let now = Instant::now();
            assert!(
                now < deadline,
                "expected {count} uploads, saw {}",
                recorded.uploads.len()
            );
            recorded = changed
                .wait_timeout(recorded, deadline - now)
                .expect("recorded")
                .0;
        }
        recorded.uploads.clone()
    }
}

fn record(sink: &Sink, update: impl FnOnce(&mut Recorded)) {
    let (lock, changed) = &**sink;
    update(&mut lock.lock().expect("recorded"));
    changed.notify_all();
}

async fn serve(socket: TcpStream, download: Option<Download>, sink: Sink) -> std::io::Result<()> {
    let mut reader = BufReader::new(socket);
    let Some(request_line) = next_line(&mut reader).await else {
        return Ok(());
    };
    let mut headers = Vec::new();
    while let Some(line) = next_line(&mut reader).await {
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_owned()));
        }
    }
    record(&sink, |recorded| {
        recorded.requests.push(request_line.clone())
    });

    let mut words = request_line.split(' ');
    let method = words.next().unwrap_or_default();
    let target = words.next().unwrap_or_default().to_owned();
    let path = target.split('?').next().unwrap_or_default().to_owned();
    let box_path = format!("/v1/boxes/{BOX_ID}");
    let files_path = format!("{box_path}/files");

    if method == "GET" && path == box_path {
        return respond(
            reader.into_inner(),
            200,
            "application/json",
            BOX_JSON.as_bytes(),
            None,
            &[],
        )
        .await;
    }
    if method == "PUT" && path == files_path {
        // `reqwest::Body::wrap_stream` has no length, so hyper frames the
        // body chunked; a client that hangs up never sends the `0` chunk.
        let (body, terminated) = read_chunked(&mut reader).await;
        record(&sink, |recorded| {
            recorded.uploads.push(Upload {
                path_and_query: target,
                headers,
                body,
                terminated,
            })
        });
        return if terminated {
            respond(
                reader.into_inner(),
                200,
                "application/json",
                b"{}",
                None,
                &[],
            )
            .await
        } else {
            Ok(())
        };
    }
    if let (true, Some(download)) = (method == "GET" && path == files_path, download) {
        let shape: Vec<(String, String)> = download
            .source_is_dir
            .map(|is_dir| vec![("X-Boxlite-Source-Is-Dir".to_owned(), is_dir.to_string())])
            .unwrap_or_default();
        let declared = download.truncate.then_some(download.body.len() + 4096);
        return respond(
            reader.into_inner(),
            200,
            "application/x-tar",
            &download.body,
            declared,
            &shape,
        )
        .await;
    }
    // A route these tests never meant to hit answers loudly instead of hanging.
    respond(
        reader.into_inner(),
        404,
        "application/json",
        br#"{"error":"no such route on the fake upstream"}"#,
        None,
        &[],
    )
    .await
}

async fn next_line<R: AsyncBufRead + Unpin>(reader: &mut R) -> Option<String> {
    let mut line = String::new();
    match reader.read_line(&mut line).await {
        Ok(0) | Err(_) => None,
        Ok(_) => Some(line.trim_end_matches(['\r', '\n']).to_owned()),
    }
}

/// Decode a chunked body. `terminated` is false when the peer went away
/// before the `0` chunk.
async fn read_chunked<R: AsyncBufRead + Unpin>(reader: &mut R) -> (Vec<u8>, bool) {
    let mut body = Vec::new();
    loop {
        let Some(size_line) = next_line(reader).await else {
            return (body, false);
        };
        let size =
            usize::from_str_radix(size_line.split(';').next().unwrap_or_default().trim(), 16)
                .expect("hyper writes well-formed chunk sizes");
        if size == 0 {
            // Trailers, then the blank line that ends the message.
            return loop {
                match next_line(reader).await {
                    None => break (body, false),
                    Some(line) if line.is_empty() => break (body, true),
                    Some(_) => {}
                }
            };
        }
        let mut chunk = vec![0u8; size + 2];
        if reader.read_exact(&mut chunk).await.is_err() {
            return (body, false);
        }
        body.extend_from_slice(&chunk[..size]);
    }
}

async fn respond(
    mut socket: TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
    declared_len: Option<usize>,
    extra: &[(String, String)],
) -> std::io::Result<()> {
    let reason = if status == 200 { "OK" } else { "Not Found" };
    let mut head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n",
        declared_len.unwrap_or(body.len())
    );
    for (name, value) in extra {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    head.push_str("\r\n");
    socket.write_all(head.as_bytes()).await?;
    socket.write_all(body).await?;
    socket.shutdown().await
}

/// Run `body` as the body of `async def main()` under `asyncio.run`, with
/// `namespace` serving as both globals and locals so the names in it resolve
/// inside `main`. A failing Python `assert` comes back as the `PyErr`.
pub(crate) fn run_python(
    py: Python<'_>,
    namespace: &Bound<'_, PyDict>,
    body: &str,
) -> PyResult<()> {
    let indented: String = body
        .trim_matches('\n')
        .lines()
        .map(|line| format!("    {line}\n"))
        .collect();
    let code = format!("import asyncio\nasync def main():\n{indented}asyncio.run(main())\n");
    let code = CString::new(code).expect("test code has no NUL");
    py.run(&code, Some(namespace), Some(namespace))
}
