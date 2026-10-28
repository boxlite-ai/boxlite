//! Real-KVM acceptance for checkpoint export and import (Linux x86_64 only).
//!
//! One box runs a long-lived guest process, pauses, exports a two-file pair,
//! then is destroyed with its home and original shares. Caller-owned recovery
//! roots, orphan FDs and the exact boot disk outlive it. A fresh runtime
//! imports the pair with those explicit bindings and resumes it, and
//! the same process must continue: same PID, start time, heap-only marker and
//! execution, with its open and unlinked files and its DAX mapping of a
//! share file intact, a counter that advances past the cut, and no write the
//! source made after the cut. Both networked shims must run the project's
//! VMM seccomp filter on every thread. A cold boot, re-exec, source-home,
//! image-cache fallback or skipped filter fails an assertion; nothing here
//! skips.
//!
//! Run with `make test:checkpoint:acceptance`, which builds the guest helper
//! (`tests/fixtures/checkpoint_helper.c`) and requires `/dev/kvm`, a runtime
//! built by `make runtime:debug` and registry access for `alpine:latest`.
//! Tracing follows `RUST_LOG`; when `BOXLITE_CHECKPOINT_LOGS` names an
//! absolute directory, each box's logs are copied there before its home goes.
#![cfg(all(target_os = "linux", target_arch = "x86_64"))]

mod common;

use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::time::Duration;

use boxlite::runtime::options::VolumeSpec;
use boxlite::{
    AttachOptions, BoxCommand, BoxOptions, BoxStatus, BoxliteError, BoxliteOptions, BoxliteRuntime,
    CheckpointImportOptions, CopyOptions, ExecStdout, LiteBox, PauseOptions, RootfsSpec,
};
use boxlite_test_utils::home::{PerTestBoxHome, live_shim_pids};
use futures::StreamExt;
use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt::writer::TestWriter;

const HELPER_ENV: &str = "BOXLITE_CHECKPOINT_HELPER";
const LOGS_ENV: &str = "BOXLITE_CHECKPOINT_LOGS";
/// Diagnostics a box leaves in its directory; disks, memory and keys are not.
const BOX_LOG_FILES: [&str; 4] = ["logs", "exit", "exit.previous", "shim.stderr"];
const HELPER_GUEST: &str = "/usr/local/bin/checkpoint_helper";
const DISK_DIR: &str = "/root/checkpoint";
const SHARE_GUEST: &str = "/mnt/share";
const HOST_IP: &str = "192.168.127.254";
const TICK_TIMEOUT: Duration = Duration::from_secs(30);
/// `WATERMARK` in `tests/fixtures/checkpoint_helper.c`.
const WATERMARK_OFFSET: u64 = 128;

/// One `tick` line of the guest helper.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Tick {
    pid: u32,
    marker: String,
    n: u64,
    dax: bool,
    state: String,
}

impl Tick {
    fn parse(line: &str) -> Option<Self> {
        let mut fields = line.strip_prefix("tick ")?.split(' ');
        let mut field = |key: &str| fields.next()?.strip_prefix(key).map(str::to_owned);
        Some(Self {
            pid: field("pid=")?.parse().ok()?,
            marker: field("marker=")?,
            n: field("n=")?.parse().ok()?,
            dax: field("dax=")? == "1",
            state: field("state=")?,
        })
    }
}

/// Splits an exec's stdout chunks into lines.
struct Lines {
    stdout: ExecStdout,
    pending: String,
    /// The helper's `start` line. An attach replays buffered output, so the
    /// line may come again, but only byte for byte: a re-executed helper
    /// prints a new marker.
    start: Option<String>,
}

impl Lines {
    fn new(stdout: ExecStdout, start: Option<String>) -> Self {
        Self {
            stdout,
            pending: String::new(),
            start,
        }
    }

    async fn next(&mut self) -> String {
        loop {
            if let Some(end) = self.pending.find('\n') {
                let line = self.pending[..end].to_owned();
                self.pending.drain(..=end);
                return line;
            }
            let chunk = tokio::time::timeout(TICK_TIMEOUT, self.stdout.next())
                .await
                .expect("guest helper went quiet")
                .expect("guest helper stdout closed");
            self.pending.push_str(&chunk);
        }
    }

    /// The next `count` ticks; every one must report intact state.
    async fn ticks(&mut self, count: usize) -> Vec<Tick> {
        let mut ticks = Vec::with_capacity(count);
        while ticks.len() < count {
            let line = self.next().await;
            if line.starts_with("start ") {
                assert_eq!(Some(&line), self.start.as_ref(), "helper restarted");
            }
            assert!(!line.starts_with("fatal "), "helper failed: {line}");
            if let Some(tick) = Tick::parse(&line) {
                assert_eq!(tick.state, "ok", "helper state broke: {line}");
                assert!(tick.dax, "the mapped share file is not DAX: {line}");
                ticks.push(tick);
            }
        }
        ticks
    }
}

async fn run(litebox: &LiteBox, program: &str, args: &[&str]) -> (i32, String) {
    let mut execution = litebox
        .exec(BoxCommand::new(program).args(args.iter().copied()))
        .await
        .unwrap_or_else(|e| panic!("exec {program} {args:?}: {e}"));
    let mut stdout = execution.stdout().expect("stdout");
    let mut output = String::new();
    while let Some(chunk) = stdout.next().await {
        output.push_str(&chunk);
    }
    let result = execution.wait().await.expect("wait");
    (result.exit_code, output)
}

async fn run_ok(litebox: &LiteBox, program: &str, args: &[&str]) -> String {
    let (code, output) = run(litebox, program, args).await;
    assert_eq!(code, 0, "{program} {args:?} failed: {output}");
    output.trim().to_owned()
}

/// Field 22 of `/proc/<pid>/stat`: start time in clock ticks since boot.
async fn start_time(litebox: &LiteBox, pid: u32) -> String {
    let stat = run_ok(litebox, "cat", &[&format!("/proc/{pid}/stat")]).await;
    let after_comm = &stat[stat.rfind(')').expect("stat comm") + 2..];
    after_comm.split(' ').nth(19).expect("starttime").to_owned()
}

async fn status(litebox: &LiteBox) -> BoxStatus {
    litebox.info().await.expect("info").status
}

fn helper_binary() -> PathBuf {
    let path = std::env::var_os(HELPER_ENV).unwrap_or_else(|| {
        panic!("{HELPER_ENV} is not set; run `make test:checkpoint:acceptance`")
    });
    let path = PathBuf::from(path);
    assert!(path.is_file(), "{} is not a file", path.display());
    path
}

fn require_kvm() {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open("/dev/kvm")
        .unwrap_or_else(|e| panic!("checkpoint acceptance needs /dev/kvm: {e}"));
}

fn process_alive(pid: u32) -> bool {
    // SAFETY: signal 0 only checks that the process exists.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

/// Serve one HTTP response carrying `token` on host loopback.
fn serve_once(token: &'static str) -> (u16, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let server = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept");
        let mut request = [0u8; 1024];
        let _ = stream.read(&mut request);
        write!(
            stream,
            "HTTP/1.0 200 OK\r\nContent-Length: {}\r\n\r\n{token}",
            token.len()
        )
        .expect("respond");
    });
    (port, server)
}

/// Read the checked v9 envelope emitted by the real producer.
fn read_checkpoint(path: &Path) -> (serde_json::Value, serde_json::Value) {
    let mut members: Vec<_> = std::fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    members.sort();
    assert_eq!(members, ["snapshot.mem", "snapshot.qcow2"]);
    let mut memory = std::fs::File::open(path.join("snapshot.mem")).unwrap();
    let mut header = [0; 160];
    memory.read_exact(&mut header).unwrap();
    assert_eq!(&header[..8], b"KRUNVM\0\0");
    assert_eq!(u32::from_le_bytes(header[8..12].try_into().unwrap()), 9);
    assert_eq!(u32::from_le_bytes(header[12..16].try_into().unwrap()), 160);
    let length = u64::from_le_bytes(header[24..32].try_into().unwrap());
    assert!(length <= 16 << 20);
    let mut metadata = vec![0; length as usize];
    memory.read_exact(&mut metadata).unwrap();
    let image: serde_json::Value = serde_json::from_slice(&metadata).unwrap();
    (image["application"].clone(), image)
}

/// Test-owned recovery points. Only descriptors retained by the guest cross
/// this boundary; untouched files under the declared roots are never copied.
struct RecoveryProvider {
    roots: std::collections::BTreeMap<String, (PathBuf, PathBuf)>,
    saved: std::sync::Mutex<Option<Recovery>>,
    boot: PathBuf,
}

struct Recovery {
    provider: boxlite::LocalCheckpointProvider,
    // LocalObject::Fd borrows these integers. Keep each role's independent
    // open description alive beyond source/runtime destruction and import.
    _files: Vec<std::fs::File>,
}

fn open_role(path: &Path, flags: i32) -> std::fs::File {
    use std::os::unix::fs::OpenOptionsExt;
    assert_eq!(flags & (libc::O_CREAT | libc::O_TRUNC | libc::O_EXCL), 0);
    let access = flags & libc::O_ACCMODE;
    std::fs::OpenOptions::new()
        .read(access != libc::O_WRONLY)
        .write(access != libc::O_RDONLY && flags & libc::O_PATH == 0)
        .custom_flags(flags | libc::O_CLOEXEC)
        .open(path)
        .unwrap_or_else(|e| panic!("open recovery role {} ({flags:#x}): {e}", path.display()))
}

#[async_trait::async_trait]
impl boxlite::CheckpointExportProvider for RecoveryProvider {
    async fn prepare(
        &self,
        request: boxlite::CheckpointExportRequest,
    ) -> Result<Vec<Vec<boxlite::ObjectReference>>, BoxliteError> {
        use std::collections::BTreeMap;
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::MetadataExt;
        let mut provider = boxlite::LocalCheckpointProvider::default();
        let mut files = Vec::new();
        let mut source_files = request.objects.into_iter();
        let mut references = Vec::new();
        for (_, recovery_root) in self.roots.values() {
            std::fs::create_dir_all(recovery_root).expect("prepare explicit recovery root");
        }
        for share in &request.shares {
            let mut refs = Vec::new();
            let mut locators = BTreeMap::new();
            for (index, object) in share.objects.iter().enumerate() {
                let source = source_files.next().expect("prepared FD");
                if share.vm_owned {
                    continue;
                }
                let (source_root, recovery_root) =
                    self.roots.get(&share.tag).expect("declared root");
                let source_path =
                    std::fs::read_link(format!("/proc/self/fd/{}", source.as_raw_fd())).unwrap();
                let orphan = source.metadata().unwrap().nlink() == 0;
                let relative = if orphan {
                    assert_eq!(share.tag, "uservol0", "unexpected retained orphan");
                    // The test retained this inode before the guest unlinked it.
                    PathBuf::from("unlinked.dat")
                } else {
                    source_path
                        .strip_prefix(source_root)
                        .unwrap_or_else(|_| {
                            panic!(
                                "{} outside declared {}",
                                source_path.display(),
                                source_root.display()
                            )
                        })
                        .to_path_buf()
                };
                let relative = if relative.as_os_str().is_empty() {
                    PathBuf::from(".")
                } else {
                    relative
                };
                let recovered = recovery_root.join(&relative);
                if source.metadata().unwrap().is_dir() {
                    std::fs::create_dir_all(&recovered).unwrap_or_else(|error| {
                        panic!(
                            "prepare recovery directory {}: {error}",
                            recovered.display()
                        )
                    });
                } else {
                    assert!(
                        source.metadata().unwrap().is_file(),
                        "fixture only prepares files/directories"
                    );
                    std::fs::create_dir_all(recovered.parent().unwrap()).unwrap();
                    std::fs::copy(format!("/proc/self/fd/{}", source.as_raw_fd()), &recovered)
                        .unwrap();
                }
                let key = format!("object-{index}");
                let locator = if source.metadata().unwrap().is_file() {
                    let object_fd = open_role(&recovered, libc::O_PATH);
                    let mut handles = BTreeMap::new();
                    for handle in share.state["handles"].as_array().unwrap() {
                        if handle["object"].as_u64() == Some(index as u64) {
                            let role =
                                open_role(&recovered, handle["flags"].as_i64().unwrap() as i32);
                            handles.insert(handle["handle"].as_u64().unwrap(), role.as_raw_fd());
                            files.push(role);
                        }
                    }
                    let mut dax_read = None;
                    let mut dax_write = None;
                    for mapping in share.state["dax"]["mappings"]
                        .as_array()
                        .into_iter()
                        .flatten()
                    {
                        let role = &mapping["kind"]["file"];
                        if role["object"].as_u64() == Some(index as u64) {
                            let writable = role["writable"].as_bool().unwrap();
                            let fd = open_role(
                                &recovered,
                                if writable {
                                    libc::O_RDWR
                                } else {
                                    libc::O_RDONLY
                                },
                            );
                            if writable {
                                dax_write = Some(fd.as_raw_fd());
                            } else {
                                dax_read = Some(fd.as_raw_fd());
                            }
                            files.push(fd);
                        }
                    }
                    let locator = boxlite::LocalObject::Fd {
                        fd: object_fd.as_raw_fd(),
                        handles,
                        dax_read,
                        dax_write,
                    };
                    files.push(object_fd);
                    if orphan {
                        std::fs::remove_file(&recovered).unwrap();
                    }
                    locator
                } else {
                    boxlite::LocalObject::Path { path: relative }
                };
                locators.insert(key.clone(), locator);
                refs.push(boxlite::ObjectReference {
                    resource_id: share.tag.clone(),
                    recovery_point: "paused-cut".into(),
                    object_key: key,
                });
                assert!(object.recipe.is_none());
            }
            if !share.vm_owned {
                let (_, root) = self.roots.get(&share.tag).unwrap();
                provider.shares.insert(share.tag.clone(), share.tag.clone());
                provider.resources.insert(
                    share.tag.clone(),
                    boxlite::LocalResource {
                        recovery_point: "paused-cut".into(),
                        root: root.clone(),
                        source_root: None,
                        objects: locators,
                    },
                );
            }
            references.push(refs);
        }
        assert!(source_files.next().is_none());
        *self.saved.lock().unwrap() = Some(Recovery {
            provider,
            _files: files,
        });
        Ok(references)
    }
}

#[async_trait::async_trait]
impl boxlite::CheckpointImportProvider for RecoveryProvider {
    async fn bind(
        &self,
        dependencies: &boxlite::CheckpointDependencies,
    ) -> Result<boxlite::CheckpointBindings, BoxliteError> {
        let mut provider = self
            .saved
            .lock()
            .unwrap()
            .as_ref()
            .expect("prepared cut")
            .provider
            .clone();
        provider
            .boot_disks
            .insert(dependencies.boot_disk_sha256.clone(), self.boot.clone());
        provider.bind(dependencies).await
    }
}

struct HoldPreparation(std::sync::Arc<tokio::sync::Notify>);
#[async_trait::async_trait]
impl boxlite::CheckpointExportProvider for HoldPreparation {
    async fn prepare(
        &self,
        _request: boxlite::CheckpointExportRequest,
    ) -> Result<Vec<Vec<boxlite::ObjectReference>>, BoxliteError> {
        self.0.notify_one();
        std::future::pending().await
    }
}

/// Whether any virtio-fs DAX ledger in the image metadata maps a file.
fn has_file_dax_mapping(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Object(map) => {
            map.get("mappings")
                .and_then(serde_json::Value::as_array)
                .is_some_and(|mappings| {
                    mappings
                        .iter()
                        .any(|mapping| mapping.pointer("/kind/file").is_some())
                })
                || map.values().any(has_file_dax_mapping)
        }
        serde_json::Value::Array(items) => items.iter().any(has_file_dax_mapping),
        _ => false,
    }
}

/// Upper bound of every counter the helper printed before the cut, read on
/// the host side of the share while the box is paused: the helper
/// atomically stores tick n as a little-endian u64 at byte
/// `WATERMARK_OFFSET` of its DAX-mapped `mapped.dat` before printing it.
fn cut_counter(share: &Path) -> u64 {
    use std::os::unix::fs::FileExt;
    let path = share.join("mapped.dat");
    let file = std::fs::File::open(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    let mut watermark = [0u8; 8];
    file.read_exact_at(&mut watermark, WATERMARK_OFFSET)
        .unwrap_or_else(|e| panic!("{} watermark: {e}", path.display()));
    u64::from_le_bytes(watermark)
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt()
        .with_env_filter(filter)
        .with_ansi(false)
        .with_writer(TestWriter::with_stderr)
        .try_init();
}

/// Copies every box's logs out of one home when dropped, so a failed start
/// still leaves its shim log, console, exit record and stderr behind after
/// the temporary home is deleted. Declare it after its home: on a panic it
/// then drops first. Copy errors are printed and never change the verdict.
struct BoxLogs {
    boxes: PathBuf,
    dest: Option<PathBuf>,
}

impl BoxLogs {
    fn new(home: &Path, label: &str) -> Self {
        let dest = std::env::var_os(LOGS_ENV).map(|dir| {
            let dir = PathBuf::from(dir);
            assert!(dir.is_absolute(), "{LOGS_ENV} must be absolute");
            dir.join(label)
        });
        Self {
            boxes: home.join("boxes"),
            dest,
        }
    }
}

impl Drop for BoxLogs {
    fn drop(&mut self) {
        let Some(dest) = &self.dest else { return };
        let Ok(boxes) = std::fs::read_dir(&self.boxes) else {
            return;
        };
        for entry in boxes.flatten() {
            for name in BOX_LOG_FILES {
                let to = dest.join(entry.file_name()).join(name);
                if let Err(e) = copy_tree(&entry.path().join(name), &to) {
                    eprintln!("saving {}: {e}", to.display());
                }
            }
        }
    }
}

/// Copies regular files and directories; a missing source is not an error.
fn copy_tree(from: &Path, to: &Path) -> std::io::Result<()> {
    let metadata = match std::fs::symlink_metadata(from) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        metadata => metadata?,
    };
    if metadata.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_tree(&entry.path(), &to.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        std::fs::create_dir_all(to.parent().expect("log destination parent"))?;
        std::fs::copy(from, to)?;
    }
    Ok(())
}

fn assert_absent(path: &Path) {
    assert!(!path.exists(), "{} still exists", path.display());
}

/// What `jailer::seccomp::apply_vmm_filter` logs once `seccomp(TSYNC)`
/// installed the project's VMM filter.
const VMM_FILTER_APPLIED: &str = "VMM seccomp filter applied to all threads (TSYNC)";

/// `(Seccomp, Seccomp_filters)` of one task, or `None` once it is gone.
fn seccomp_state(task: &Path) -> Option<(u32, u32)> {
    let status = std::fs::read_to_string(task.join("status")).ok()?;
    let field = |name: &str| {
        status
            .lines()
            .find_map(|l| l.strip_prefix(name)?.trim().parse().ok())
            .unwrap_or_else(|| panic!("{}/status has no {name}", task.display()))
    };
    Some((field("Seccomp:"), field("Seccomp_filters:")))
}

/// The parent of every process, read from `/proc/*/stat`.
fn process_parents() -> Vec<(u32, u32)> {
    std::fs::read_dir("/proc")
        .expect("read /proc")
        .flatten()
        .filter_map(|entry| {
            let pid = entry.file_name().to_str()?.parse().ok()?;
            let stat = std::fs::read_to_string(entry.path().join("stat")).ok()?;
            // `pid (comm) state ppid ...`; comm may hold spaces.
            let ppid = stat.rsplit_once(')')?.1.split_whitespace().nth(1)?;
            Some((pid, ppid.parse().ok()?))
        })
        .collect()
}

/// The `boxlite-shim` process below `launcher`, the box's recorded PID
/// (bwrap's outer process).
fn shim_process(launcher: u32) -> u32 {
    let parents = process_parents();
    let mut pending = vec![launcher];
    while let Some(pid) = pending.pop() {
        let cmdline = std::fs::read(format!("/proc/{pid}/cmdline")).unwrap_or_default();
        let program = cmdline.split(|b| *b == 0).next().unwrap_or_default();
        if Path::new(std::str::from_utf8(program).unwrap_or_default()).ends_with("boxlite-shim") {
            return pid;
        }
        pending.extend(parents.iter().filter(|(_, p)| *p == pid).map(|(c, _)| *c));
    }
    panic!("no boxlite-shim process below {launcher}")
}

/// Every thread of the box's shim runs the project's VMM filter, installed
/// by the shim itself: nothing above the shim has a filter, each thread has
/// exactly one, and the shim logged installing it. Threads started during
/// the scan are scanned too; one may be skipped only once it is gone.
async fn assert_vmm_filter_on_every_thread(home: &Path, litebox: &LiteBox) {
    let launcher = litebox.info().await.expect("info").pid.expect("shim pid");
    let shim = shim_process(launcher);
    let parent = process_parents()
        .into_iter()
        .find_map(|(pid, ppid)| (pid == shim).then_some(ppid))
        .expect("shim parent");
    for ancestor in [
        Path::new("/proc/self"),
        &PathBuf::from(format!("/proc/{parent}")),
    ] {
        assert_eq!(
            seccomp_state(ancestor).map(|(mode, _)| mode),
            Some(0),
            "{} must not carry a seccomp filter the shim could inherit",
            ancestor.display()
        );
    }

    let tasks = PathBuf::from(format!("/proc/{shim}/task"));
    let mut checked = std::collections::BTreeMap::new();
    loop {
        let listed: Vec<u32> = std::fs::read_dir(&tasks)
            .expect("shim tasks")
            .flatten()
            .filter_map(|e| e.file_name().to_str()?.parse().ok())
            .filter(|tid| !checked.contains_key(tid))
            .collect();
        if listed.is_empty() {
            break;
        }
        for tid in listed {
            let task = tasks.join(tid.to_string());
            let comm = std::fs::read_to_string(task.join("comm")).unwrap_or_default();
            match seccomp_state(&task) {
                Some(state) => assert_eq!(
                    state,
                    (2, 1),
                    "shim {shim} thread {tid} ({}) is not under exactly one filter",
                    comm.trim()
                ),
                None => assert!(
                    tid != shim && !task.exists(),
                    "shim {shim} thread {tid} is alive but unreadable"
                ),
            }
            checked.insert(tid, comm.trim().to_owned());
        }
    }
    assert!(
        checked.contains_key(&shim) && checked.len() > 1,
        "{checked:?}"
    );
    eprintln!("shim {shim}: VMM filter on every thread: {checked:?}");

    let logs = home.join("boxes").join(litebox.id().as_str()).join("logs");
    let log: String = std::fs::read_dir(&logs)
        .unwrap_or_else(|e| panic!("{}: {e}", logs.display()))
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("boxlite-shim.log")
        })
        .map(|e| std::fs::read_to_string(e.path()).expect("shim log"))
        .collect();
    assert!(
        log.contains(VMM_FILTER_APPLIED),
        "the shim never logged its VMM filter"
    );
    assert!(
        !log.contains("Seccomp disabled"),
        "the shim skipped seccomp"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "real KVM acceptance; run with `make test:checkpoint:acceptance`"]
async fn checkpoint_continues_the_same_guest_process_in_a_new_runtime() {
    init_tracing();
    require_kvm();
    let helper = helper_binary();

    // ── Source: its own home and image cache, nothing linked from outside ──
    let source_home = PerTestBoxHome::isolated();
    let source_home_path = source_home.path.clone();
    let source_logs = BoxLogs::new(&source_home_path, "source");
    let share = tempfile::tempdir().expect("share dir");
    let share_path = share.path().to_path_buf();
    let checkpoint_dir = tempfile::tempdir().expect("checkpoint dir");
    let checkpoint = checkpoint_dir.path().join("source-checkpoint");
    let recovery = tempfile::tempdir().expect("caller-owned recovery resources");
    // Retain the source inode before the helper unlinks it, independently of
    // the VM's own open file handle.
    let source_orphan = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(share_path.join("unlinked.dat"))
        .unwrap();
    std::fs::write(share_path.join("untouched"), b"never retained by the guest").unwrap();

    let source_rt = BoxliteRuntime::new(BoxliteOptions {
        home_dir: source_home_path.clone(),
        image_registries: common::test_registries(),
        ..Default::default()
    })
    .expect("source runtime");
    let options = BoxOptions {
        rootfs: RootfsSpec::Image("alpine:latest".into()),
        memory_mib: Some(256),
        auto_delete: Some(0),
        volumes: vec![VolumeSpec::bind_mount(
            share_path.to_str().expect("utf-8 share"),
            SHARE_GUEST,
        )],
        ..Default::default()
    };
    let source = source_rt
        .create(options, Some("checkpoint-source".into()))
        .await
        .expect("create default box");
    let source_id = source.id().clone();
    source.start().await.expect("start");

    source
        .copy_into(&helper, HELPER_GUEST, CopyOptions::default())
        .await
        .expect("copy helper");
    run_ok(&source, "chmod", &["0755", HELPER_GUEST]).await;
    run_ok(&source, "mkdir", &["-p", DISK_DIR]).await;
    let boot_id = run_ok(&source, "cat", &["/proc/sys/kernel/random/boot_id"]).await;

    // ── Long-lived guest process ──
    let mut workload = source
        .exec(BoxCommand::new(HELPER_GUEST).args([DISK_DIR, SHARE_GUEST]))
        .await
        .expect("start helper");
    let execution_id = workload.id().clone();
    let mut lines = Lines::new(workload.stdout().expect("helper stdout"), None);
    let start = lines.next().await;
    lines.start = Some(start.clone());
    let start_fields: Vec<&str> = start.split(' ').collect();
    assert_eq!(start_fields.first(), Some(&"start"), "{start}");
    let pid: u32 = start_fields[1]
        .strip_prefix("pid=")
        .and_then(|pid| pid.parse().ok())
        .unwrap_or_else(|| panic!("no pid in {start}"));
    let marker = start_fields[2]
        .strip_prefix("marker=")
        .unwrap_or_else(|| panic!("no marker in {start}"))
        .to_owned();
    let share_mount = lines.next().await;
    assert!(share_mount.contains(" - virtiofs "), "{share_mount}");
    assert!(
        share_mount.contains("dax=always"),
        "the share is not mounted with dax=always: {share_mount}"
    );
    eprintln!("share mount: {share_mount}");
    let before_cut = lines.ticks(5).await;
    assert!(
        before_cut
            .iter()
            .all(|t| t.pid == pid && t.marker == marker)
    );
    let started = start_time(&source, pid).await;

    // ── The networked source shim runs the project's VMM filter ──
    assert_vmm_filter_on_every_thread(&source_home_path, &source).await;

    // Disk capture and full checkpoints coexist on a default owner. A live
    // capture preserves the opened source inode and returns Running.
    let source_disk = source_home_path
        .join("boxes")
        .join(source_id.as_str())
        .join("disks/disk.qcow2");
    use std::os::unix::fs::MetadataExt;
    let live_disk = std::fs::File::open(&source_disk).unwrap();
    let disk_inode = live_disk.metadata().unwrap().ino();
    source
        .snapshots()
        .create(Default::default(), "before-checkpoint")
        .await
        .expect("running snapshot");
    assert_eq!(status(&source).await, BoxStatus::Running);
    assert_eq!(std::fs::metadata(&source_disk).unwrap().ino(), disk_inode);

    // ── Pause: an external share needs the writer assertion ──
    let refused = source.pause(PauseOptions::default()).await;
    assert!(
        matches!(refused, Err(BoxliteError::InvalidArgument(_))),
        "pause without the writer assertion: {refused:?}"
    );
    assert_eq!(status(&source).await, BoxStatus::Running);
    source
        .pause(PauseOptions {
            host_writers_stopped: true,
        })
        .await
        .expect("pause");
    assert_eq!(status(&source).await, BoxStatus::Paused);
    assert!(
        source.exec(BoxCommand::new("true")).await.is_err(),
        "a paused box must refuse exec"
    );
    assert!(
        source
            .snapshots()
            .create(Default::default(), "must-not-stage")
            .await
            .is_err()
    );
    assert!(
        source
            .snapshots()
            .get("must-not-stage")
            .await
            .unwrap()
            .is_none()
    );
    // Buffered output may replay on attach; only a counter past this bound
    // proves the helper ran after the cut.
    assert_eq!(
        source_orphan.metadata().unwrap().nlink(),
        0,
        "guest did not unlink retained host inode"
    );
    let cut = cut_counter(&share_path);
    assert!(
        cut >= before_cut.last().expect("ticks").n,
        "the share lags the printed counter"
    );

    // The exact readonly boot backend must outlive the source cache. Copy
    // its resolved target, not a rebuilt or merely compatible boot image.
    let boot = recovery.path().join("exact-boot.ext4");
    let provider = RecoveryProvider {
        roots: std::collections::BTreeMap::from([
            (
                "uservol0".into(),
                (share_path.clone(), recovery.path().join("volume")),
            ),
            (
                "BoxLiteShared".into(),
                (
                    source_home_path
                        .join("boxes")
                        .join(source_id.as_str())
                        .join("shared"),
                    recovery.path().join("shared"),
                ),
            ),
        ]),
        saved: std::sync::Mutex::new(None),
        boot,
    };
    // ── Export exactly two files; an ordinary failure stays paused ──
    source
        .export_checkpoint(&checkpoint, &provider)
        .await
        .expect("export checkpoint");
    assert!(checkpoint.is_dir());
    let dependencies = BoxliteRuntime::inspect_checkpoint(&checkpoint).expect("inspect pair");
    // The boot dependency is not in the pair. Select the exact source cache
    // backend by the producer's digest and retain its bytes independently.
    use sha2::{Digest, Sha256};
    let mut exact_boot = None;
    for entry in std::fs::read_dir(source_home_path.join("bases")).unwrap() {
        let path = entry.unwrap().path();
        if path.is_file() && std::fs::metadata(&path).unwrap().len() == dependencies.boot_disk_bytes
        {
            let digest = hex::encode(Sha256::digest(std::fs::read(&path).unwrap()));
            if digest == dependencies.boot_disk_sha256 {
                exact_boot = Some(path);
                break;
            }
        }
    }
    std::fs::copy(
        exact_boot.expect("exact readonly boot backend"),
        &provider.boot,
    )
    .unwrap();
    let original_disk_digest =
        Sha256::digest(std::fs::read(checkpoint.join("snapshot.qcow2")).unwrap());
    let exported_len = std::fs::metadata(checkpoint.join("snapshot.mem"))
        .expect("checkpoint")
        .len();
    assert!(
        source
            .export_checkpoint(&checkpoint, &provider)
            .await
            .is_err(),
        "an existing destination must never be overwritten"
    );
    assert_eq!(
        std::fs::metadata(checkpoint.join("snapshot.mem"))
            .expect("checkpoint")
            .len(),
        exported_len
    );
    assert_eq!(status(&source).await, BoxStatus::Paused);
    assert_eq!(
        cut_counter(&share_path),
        cut,
        "the helper wrote while the box was paused"
    );
    let (manifest, image) = read_checkpoint(&checkpoint);
    assert_eq!(manifest["source_box_id"], source_id.as_str());
    let container_id = manifest
        .pointer("/guest/container_id")
        .and_then(serde_json::Value::as_str)
        .expect("manifest guest.container_id")
        .to_owned();
    assert!(!container_id.is_empty());
    assert!(
        has_file_dax_mapping(&image),
        "the checkpoint holds no file DAX mapping for the helper's mapped file"
    );

    // ── The source runs on and changes everything after the cut ──
    // Host-guest RPC connections do not survive a pause: reattach.
    drop(lines);
    source.resume().await.expect("resume source");
    let mut source_attach = source
        .attach(AttachOptions::execution(execution_id.clone()).read_only())
        .await
        .expect("reattach source execution");
    let mut lines = Lines::new(
        source_attach.stdout().expect("source stdout"),
        Some(start.clone()),
    );
    let mut source_progress = 0;
    while source_progress <= cut + 5 {
        source_progress = lines.ticks(1).await[0].n;
    }
    assert!(
        cut_counter(&share_path) > cut,
        "the source watermark did not move past the cut"
    );
    std::fs::write(share_path.join("host-after-cut"), b"source").expect("host write");
    run_ok(
        &source,
        "touch",
        &[
            &format!("{DISK_DIR}/guest-after-cut"),
            &format!("{SHARE_GUEST}/guest-after-cut"),
        ],
    )
    .await;

    // ── Destroy the source VM and every resource this test made for it ──
    let source_shim = source.info().await.expect("info").pid.expect("shim pid");
    drop(lines);
    drop(source_attach);
    drop(workload);
    source.stop().await.expect("stop source");
    drop(source_logs);
    source_rt
        .remove(source_id.as_str(), true)
        .await
        .expect("remove source");
    source_rt
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await
        .expect("shutdown source runtime");
    drop(source);
    drop(source_rt);
    assert!(
        !process_alive(source_shim),
        "source shim {source_shim} survived"
    );
    assert!(live_shim_pids(&source_home_path.join("boxes")).is_empty());
    drop(source_home);
    drop(source_orphan);
    drop(share);
    assert_absent(&source_home_path);
    assert_absent(&share_path);
    assert_absent(&recovery.path().join("volume/untouched"));

    // ── Import into a fresh, empty runtime: paused until resumed ──
    let target_home = PerTestBoxHome::isolated();
    let target_logs = BoxLogs::new(&target_home.path, "restored");
    let target_rt = BoxliteRuntime::new(BoxliteOptions {
        home_dir: target_home.path.clone(),
        ..Default::default()
    })
    .expect("target runtime");
    let restored = target_rt
        .import_checkpoint(
            &checkpoint,
            CheckpointImportOptions {
                name: Some("checkpoint-restored".into()),
            },
            &provider,
        )
        .await
        .expect("import checkpoint");
    assert_ne!(restored.id(), &source_id, "import must mint a new box id");
    assert_eq!(status(&restored).await, BoxStatus::Paused);
    assert!(
        restored.exec(BoxCommand::new("true")).await.is_err(),
        "an imported box must refuse exec before resume"
    );
    assert!(
        restored
            .attach(AttachOptions::execution(execution_id.clone()))
            .await
            .is_err(),
        "an imported box must refuse attach before resume"
    );

    // Resume fails and stops the VM unless the guest reports the container
    // the manifest retained (`container_id`) running and initialized.
    restored.resume().await.expect("resume restored box");
    assert_eq!(status(&restored).await, BoxStatus::Running);

    // ── Same process, same execution, state from the cut, still counting ──
    let mut attached = restored
        .attach(AttachOptions::execution(execution_id.clone()).read_only())
        .await
        .expect("reattach original execution");
    assert_eq!(attached.id(), &execution_id);
    let mut lines = Lines::new(attached.stdout().expect("reattached stdout"), Some(start));
    // The attach may first replay buffered ticks from before the cut; read
    // until the counter is well past it.
    let mut restored_ticks = Vec::new();
    while restored_ticks.last().is_none_or(|t: &Tick| t.n < cut + 10) {
        restored_ticks.extend(lines.ticks(1).await);
    }
    for tick in &restored_ticks {
        assert_eq!((tick.pid, tick.marker.as_str()), (pid, marker.as_str()));
    }
    assert!(
        restored_ticks.windows(2).all(|w| w[1].n == w[0].n + 1),
        "counter must advance by one per tick: {restored_ticks:?}"
    );
    let last = restored_ticks.last().expect("ticks").n;
    eprintln!("cut <= {cut}, source reached {source_progress}, restored reached {last}");

    assert_eq!(
        run_ok(&restored, "cat", &["/proc/sys/kernel/random/boot_id"]).await,
        boot_id,
        "the guest kernel rebooted"
    );
    assert_eq!(
        start_time(&restored, pid).await,
        started,
        "the helper was re-executed"
    );
    for path in [
        format!("{DISK_DIR}/guest-after-cut"),
        format!("{SHARE_GUEST}/guest-after-cut"),
        format!("{SHARE_GUEST}/host-after-cut"),
    ] {
        let (code, _) = run(&restored, "test", &["!", "-e", &path]).await;
        assert_eq!(code, 0, "{path} was written after the cut but was restored");
    }

    // ── New RPC work: exec + wait, and a new network connection ──
    let (code, output) = run(&restored, "sh", &["-c", "echo new-exec"]).await;
    assert_eq!((code, output.trim()), (0, "new-exec"));
    let (port, server) = serve_once("checkpoint-network-ok");
    let fetched = run_ok(
        &restored,
        "wget",
        &["-q", "-O", "-", &format!("http://{HOST_IP}:{port}/")],
    )
    .await;
    assert_eq!(fetched, "checkpoint-network-ok");
    server.join().expect("server");
    // The restored shim, including what the connection started, is filtered.
    assert_vmm_filter_on_every_thread(&target_home.path, &restored).await;

    // The original execution still answers control: kill, then wait.
    attached.kill().await.expect("kill helper");
    let result = tokio::time::timeout(TICK_TIMEOUT, attached.wait())
        .await
        .expect("helper did not exit")
        .expect("wait helper");
    assert_ne!(result.exit_code, 0, "a killed helper cannot exit cleanly");

    // Nothing was pulled or cached to restore the box.
    let images = target_rt
        .images()
        .expect("images")
        .list()
        .await
        .expect("list");
    assert!(
        images.is_empty(),
        "import fell back to an image: {images:?}"
    );

    // Imported boxes also support disk snapshot -> full checkpoint -> resume.
    let imported_snapshot = restored
        .snapshots()
        .create(Default::default(), "imported-disk-cut")
        .await;
    if let Err(error) = imported_snapshot {
        restored
            .pause(PauseOptions {
                host_writers_stopped: true,
            })
            .await
            .expect("pause failed disk for diagnostics");
        if let Some(directory) = std::env::var_os(LOGS_ENV) {
            let disk = target_home
                .path
                .join("boxes")
                .join(restored.id().as_str())
                .join("disks/disk.qcow2");
            std::fs::copy(
                disk,
                PathBuf::from(directory).join("failed-imported-disk.qcow2"),
            )
            .expect("preserve failed disk");
        }
        panic!("imported running snapshot: {error}");
    }
    assert_eq!(status(&restored).await, BoxStatus::Running);
    let second_recovery = tempfile::tempdir().unwrap();
    let provider2 = RecoveryProvider {
        roots: std::collections::BTreeMap::from([
            (
                "uservol0".into(),
                (
                    recovery.path().join("volume"),
                    second_recovery.path().join("volume"),
                ),
            ),
            (
                "BoxLiteShared".into(),
                (
                    recovery.path().join("shared"),
                    second_recovery.path().join("shared"),
                ),
            ),
        ]),
        saved: std::sync::Mutex::new(None),
        boot: provider.boot.clone(),
    };
    restored
        .pause(PauseOptions {
            host_writers_stopped: true,
        })
        .await
        .unwrap();
    let second_pair = checkpoint_dir.path().join("imported-checkpoint");
    restored
        .export_checkpoint(&second_pair, &provider2)
        .await
        .expect("checkpoint after disk snapshot on import");
    let _ = read_checkpoint(&second_pair);
    restored.resume().await.unwrap();
    assert_eq!(
        Sha256::digest(std::fs::read(checkpoint.join("snapshot.qcow2")).unwrap()),
        original_disk_digest,
        "restored writes changed the input pair"
    );
    let private_disk = target_home
        .path
        .join("boxes")
        .join(restored.id().as_str())
        .join("disks/disk.qcow2");
    let private = std::fs::metadata(&private_disk).unwrap();
    let artifact = std::fs::metadata(checkpoint.join("snapshot.qcow2")).unwrap();
    assert_ne!(
        (private.dev(), private.ino()),
        (artifact.dev(), artifact.ino())
    );
    assert_eq!(private.nlink(), 1, "writable imported disk must be private");

    // Cancel a real owner session after descriptor preparation. Dropping the
    // host future closes its silent lifetime stream; the owner must stop,
    // never silently resume or publish a partial pair.
    restored
        .pause(PauseOptions {
            host_writers_stopped: true,
        })
        .await
        .unwrap();
    let prepared = std::sync::Arc::new(tokio::sync::Notify::new());
    let canceller_box = target_rt
        .get(restored.id().as_str())
        .await
        .unwrap()
        .unwrap();
    let cancelled_path = checkpoint_dir.path().join("cancelled");
    let destination = cancelled_path.clone();
    let signal = prepared.clone();
    let export = tokio::spawn(async move {
        canceller_box
            .export_checkpoint(destination, &HoldPreparation(signal))
            .await
    });
    tokio::time::timeout(TICK_TIMEOUT, prepared.notified())
        .await
        .expect("capture never prepared");
    export.abort();
    assert!(export.await.unwrap_err().is_cancelled());
    tokio::time::timeout(TICK_TIMEOUT, async {
        while status(&restored).await != BoxStatus::Stopped {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("disconnected capture owner did not stop");
    assert!(
        !cancelled_path.exists(),
        "cancelled export published a pair"
    );
    restored
        .stop()
        .await
        .expect("join cancelled restored owner");
    // Cold start uses the saved private QCOW2, exact external boot backend and
    // persistent roots, after the source cache and box have been destroyed.
    let restored = target_rt
        .get(restored.id().as_str())
        .await
        .unwrap()
        .unwrap();
    restored.start().await.expect("cold start imported storage");
    assert_eq!(
        run_ok(
            &restored,
            "sh",
            &["-c", "test -f /root/checkpoint/disk.dat && echo retained"]
        )
        .await,
        "retained"
    );
    restored.stop().await.expect("stop cold-started import");
    drop(target_logs);
    target_rt
        .remove(restored.id().as_str(), true)
        .await
        .expect("remove restored");
    let _ = target_rt
        .shutdown(Some(common::TEST_SHUTDOWN_TIMEOUT))
        .await;
}
