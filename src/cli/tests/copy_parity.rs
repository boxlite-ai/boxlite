//! `boxlite cp` behavioral parity across backends.
//!
//! Runs the same `copy_in` / `copy_out` scenarios two ways and asserts they
//! produce identical, docker-cp-correct results:
//!
//!   P1 "local" — `boxlite cp`               (in-process backend)
//!   P2 "serve" — `boxlite --url <serve> cp` (REST client → `boxlite serve`)
//!
//! This is the behavioral proof for the REST/serve copy-parity work on PR #648:
//! both paths must match the local backend's docker-cp semantics and honor
//! `--overwrite` / `--include-parent` / `--follow-symlinks`. The local backend
//! is already covered field-by-field in `src/boxlite/tests/copy.rs`; what this
//! test uniquely exercises is the REST client → serve server path (F-010
//! copy-out, the `extracted/` leak, and option plumbing over HTTP).
//!
//! Like the rest of `src/cli/tests`, this drives the real `boxlite` binary
//! (`CARGO_BIN_EXE_boxlite`) against real boxes, so it runs only on a
//! box-capable host (macOS Apple Silicon w/ libkrun, Linux w/ KVM).
//!
//! Run with:
//!
//! ```sh
//! cargo test -p boxlite-cli --test copy_parity -- --nocapture
//! ```

mod common;

use boxlite_test_utils::TEST_REGISTRIES;
use boxlite_test_utils::home::PerTestBoxHome;
use std::fs;
use std::net::{TcpListener, TcpStream};
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const IMAGE: &str = "alpine:latest";
const LOCAL_BOX: &str = "cp-local";
const SERVE_BOX: &str = "cp-serve";

fn bin() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_boxlite"))
}

/// Global args for the in-process backend: isolated home + test registries.
fn local_base(home: &Path) -> Vec<String> {
    let mut base = vec!["--home".to_string(), home.display().to_string()];
    for reg in TEST_REGISTRIES {
        base.push("--registry".to_string());
        base.push((*reg).to_string());
    }
    base
}

/// Global args for the REST client: just `--url` (image pull happens serve-side).
fn serve_base(port: u16) -> Vec<String> {
    vec!["--url".to_string(), format!("http://127.0.0.1:{port}")]
}

struct RunOut {
    success: bool,
    stdout: String,
}

/// Invoke the real `boxlite` binary with the given global base + subcommand args.
fn run(base: &[String], extra: &[&str]) -> RunOut {
    let out = Command::new(bin())
        .args(base)
        .args(extra)
        .output()
        .expect("spawn boxlite");
    RunOut {
        success: out.status.success(),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
    }
}

/// Normalized signature of a path *inside the box*:
/// `file:<contents>` | `dir` | `symlink:<target>` | `missing`.
///
/// Contents (not a hash) keep this dependency-free; every parity scenario uses
/// short, newline-free ASCII payloads, so a single `cat` line is unambiguous.
fn box_state(base: &[String], box_name: &str, path: &str) -> String {
    let script = format!(
        "if [ -L '{p}' ]; then echo \"symlink:$(readlink '{p}')\"; \
         elif [ -d '{p}' ]; then echo dir; \
         elif [ -f '{p}' ]; then echo \"file:$(cat '{p}')\"; \
         else echo missing; fi",
        p = path
    );
    let out = run(base, &["exec", box_name, "--", "/bin/sh", "-c", &script]);
    out.stdout.trim().to_string()
}

/// Same signature as [`box_state`], computed for a path on the host.
fn host_state(path: &Path) -> String {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(_) => return "missing".to_string(),
    };
    let kind = meta.file_type();
    if kind.is_symlink() {
        let target = fs::read_link(path).expect("read_link");
        format!("symlink:{}", target.display())
    } else if kind.is_dir() {
        "dir".to_string()
    } else if kind.is_file() {
        let contents = fs::read_to_string(path).expect("read host file");
        format!("file:{contents}")
    } else {
        "missing".to_string()
    }
}

/// Accumulates parity results so a single failed scenario does not abort the
/// run before teardown (mirrors the former script's PASS/FAIL tally).
#[derive(Default)]
struct Parity {
    failures: Vec<String>,
}

impl Parity {
    /// Assert local == serve == expected for one scenario.
    fn check(&mut self, label: &str, expected: &str, local: &str, serve: &str) {
        if local == expected && serve == expected {
            eprintln!("  PASS {label} (both={expected})");
        } else {
            let msg = format!("{label}: expected={expected} local={local} serve={serve}");
            eprintln!("  FAIL {msg}");
            self.failures.push(msg);
        }
    }

    /// Assert a command failed on both backends (e.g. `--no-overwrite` refusal).
    fn check_both_fail(&mut self, label: &str, local_success: bool, serve_success: bool) {
        if !local_success && !serve_success {
            eprintln!("  PASS {label} (both rejected)");
        } else {
            let msg = format!(
                "{label}: expected non-zero exit, got local_success={local_success} \
                 serve_success={serve_success}"
            );
            eprintln!("  FAIL {msg}");
            self.failures.push(msg);
        }
    }
}

/// Owns the `boxlite serve` child so it is always killed, even on panic.
struct ServeProcess {
    child: Child,
    port: u16,
    log_path: PathBuf,
}

impl ServeProcess {
    fn spawn(home: &Path, log_path: PathBuf) -> Self {
        let port = ephemeral_port();
        let log = fs::File::create(&log_path).expect("create serve log");
        let log_err = log.try_clone().expect("clone serve log");

        let mut base = vec!["--home".to_string(), home.display().to_string()];
        for reg in TEST_REGISTRIES {
            base.push("--registry".to_string());
            base.push((*reg).to_string());
        }
        let child = Command::new(bin())
            .args(&base)
            .args(["serve", "--port", &port.to_string(), "--host", "127.0.0.1"])
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err))
            .spawn()
            .expect("spawn boxlite serve");

        let serve = Self {
            child,
            port,
            log_path,
        };
        serve.wait_ready();
        serve
    }

    /// Block until the server accepts TCP connections, or panic with its log.
    fn wait_ready(&self) {
        let deadline = Instant::now() + Duration::from_secs(30);
        let addr = format!("127.0.0.1:{}", self.port);
        while Instant::now() < deadline {
            if TcpStream::connect(&addr).is_ok() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let log = fs::read_to_string(&self.log_path).unwrap_or_default();
        panic!("serve did not become ready on {addr}\n--- serve log ---\n{log}");
    }
}

impl Drop for ServeProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Reserve an ephemeral loopback port, then release it for `serve` to bind.
fn ephemeral_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    listener.local_addr().expect("local_addr").port()
}

#[test]
fn copy_parity_local_vs_serve() {
    let local_home = PerTestBoxHome::new();
    let serve_home = PerTestBoxHome::new();
    let work = tempfile::TempDir::new_in("/tmp").expect("work dir");
    let work = work.path();

    let local = local_base(&local_home.path);
    let serve_proc = ServeProcess::spawn(&serve_home.path, work.join("serve.log"));
    let serve = serve_base(serve_proc.port);

    // Boot a long-lived box on each backend.
    let local_run = run(
        &local,
        &[
            "run",
            "-d",
            "--name",
            LOCAL_BOX,
            IMAGE,
            "--",
            "/bin/sh",
            "-c",
            "sleep 600",
        ],
    );
    assert!(local_run.success, "start local box: {}", local_run.stdout);
    let serve_run = run(
        &serve,
        &[
            "run",
            "-d",
            "--name",
            SERVE_BOX,
            IMAGE,
            "--",
            "/bin/sh",
            "-c",
            "sleep 600",
        ],
    );
    assert!(serve_run.success, "start serve box: {}", serve_run.stdout);

    let mut parity = Parity::default();
    run_scenarios(&mut parity, &local, &serve, work);

    // Explicit teardown before the homes drop (PerTestBoxHome panics on a leaked
    // shim). `--url rm` removes the serve box; ServeProcess::drop kills serve.
    let _ = run(&serve, &["rm", "--force", SERVE_BOX]);
    let _ = run(&local, &["rm", "--force", LOCAL_BOX]);
    drop(serve_proc);

    assert!(
        parity.failures.is_empty(),
        "{} parity failure(s):\n{}",
        parity.failures.len(),
        parity.failures.join("\n")
    );
}

/// A box spec `name:path` for the `cp` argument.
fn at(box_name: &str, path: &str) -> String {
    format!("{box_name}:{path}")
}

#[allow(clippy::too_many_lines)]
fn run_scenarios(parity: &mut Parity, local: &[String], serve: &[String], work: &Path) {
    // === copy_in ============================================================
    eprintln!("== copy_in scenarios ==");

    // 1. file → nonexistent dst path → regular file at the exact path
    //    (the #384 `extracted/` leak fix).
    let f1 = work.join("f1.txt");
    fs::write(&f1, "hello-one").unwrap();
    let f1s = f1.display().to_string();
    run(local, &["cp", &f1s, &at(LOCAL_BOX, "/root/one.txt")]);
    run(serve, &["cp", &f1s, &at(SERVE_BOX, "/root/one.txt")]);
    parity.check(
        "copy_in file→nonexistent is file",
        "file:hello-one",
        &box_state(local, LOCAL_BOX, "/root/one.txt"),
        &box_state(serve, SERVE_BOX, "/root/one.txt"),
    );

    // 2. file → existing dir → dir/<basename>.
    run(local, &["exec", LOCAL_BOX, "--", "mkdir", "-p", "/root/d2"]);
    run(serve, &["exec", SERVE_BOX, "--", "mkdir", "-p", "/root/d2"]);
    run(local, &["cp", &f1s, &at(LOCAL_BOX, "/root/d2")]);
    run(serve, &["cp", &f1s, &at(SERVE_BOX, "/root/d2")]);
    parity.check(
        "copy_in file→existing dir lands inside",
        "file:hello-one",
        &box_state(local, LOCAL_BOX, "/root/d2/f1.txt"),
        &box_state(serve, SERVE_BOX, "/root/d2/f1.txt"),
    );

    // 3. dir, include_parent=true (docker-cp default) → /root/p3/<dirname>/a.txt.
    let sd = work.join("sd");
    fs::create_dir(&sd).unwrap();
    fs::write(sd.join("a.txt"), "aaa").unwrap();
    let sds = sd.display().to_string();
    run(local, &["exec", LOCAL_BOX, "--", "mkdir", "-p", "/root/p3"]);
    run(serve, &["exec", SERVE_BOX, "--", "mkdir", "-p", "/root/p3"]);
    run(local, &["cp", &sds, &at(LOCAL_BOX, "/root/p3")]);
    run(serve, &["cp", &sds, &at(SERVE_BOX, "/root/p3")]);
    parity.check(
        "copy_in dir include_parent=true keeps dirname",
        "file:aaa",
        &box_state(local, LOCAL_BOX, "/root/p3/sd/a.txt"),
        &box_state(serve, SERVE_BOX, "/root/p3/sd/a.txt"),
    );

    // 3b. dir, include_parent=false → contents flattened into dst.
    run(
        local,
        &["exec", LOCAL_BOX, "--", "mkdir", "-p", "/root/p3f"],
    );
    run(
        serve,
        &["exec", SERVE_BOX, "--", "mkdir", "-p", "/root/p3f"],
    );
    run(
        local,
        &[
            "cp",
            "--no-include-parent",
            &sds,
            &at(LOCAL_BOX, "/root/p3f"),
        ],
    );
    run(
        serve,
        &[
            "cp",
            "--no-include-parent",
            &sds,
            &at(SERVE_BOX, "/root/p3f"),
        ],
    );
    parity.check(
        "copy_in dir include_parent=false flattens",
        "file:aaa",
        &box_state(local, LOCAL_BOX, "/root/p3f/a.txt"),
        &box_state(serve, SERVE_BOX, "/root/p3f/a.txt"),
    );

    // 4. --no-overwrite rejects an existing file; original is left unchanged.
    run(
        local,
        &[
            "exec",
            LOCAL_BOX,
            "--",
            "/bin/sh",
            "-c",
            "printf orig >/root/ov.txt",
        ],
    );
    run(
        serve,
        &[
            "exec",
            SERVE_BOX,
            "--",
            "/bin/sh",
            "-c",
            "printf orig >/root/ov.txt",
        ],
    );
    let local_reject = run(
        local,
        &["cp", "--no-overwrite", &f1s, &at(LOCAL_BOX, "/root/ov.txt")],
    );
    let serve_reject = run(
        serve,
        &["cp", "--no-overwrite", &f1s, &at(SERVE_BOX, "/root/ov.txt")],
    );
    parity.check_both_fail(
        "copy_in --no-overwrite rejects",
        local_reject.success,
        serve_reject.success,
    );
    parity.check(
        "copy_in --no-overwrite leaves original",
        "file:orig",
        &box_state(local, LOCAL_BOX, "/root/ov.txt"),
        &box_state(serve, SERVE_BOX, "/root/ov.txt"),
    );

    // 5. follow_symlinks (host → box): a dir with target.txt + link.txt→target.txt.
    let lk = work.join("lk");
    fs::create_dir(&lk).unwrap();
    fs::write(lk.join("target.txt"), "data").unwrap();
    symlink("target.txt", lk.join("link.txt")).unwrap();
    let lks = lk.display().to_string();

    // 5a. default (follow_symlinks=false) → the symlink is preserved.
    run(
        local,
        &["exec", LOCAL_BOX, "--", "mkdir", "-p", "/root/lkdef"],
    );
    run(
        serve,
        &["exec", SERVE_BOX, "--", "mkdir", "-p", "/root/lkdef"],
    );
    run(local, &["cp", &lks, &at(LOCAL_BOX, "/root/lkdef")]);
    run(serve, &["cp", &lks, &at(SERVE_BOX, "/root/lkdef")]);
    parity.check(
        "copy_in default preserves symlink",
        "symlink:target.txt",
        &box_state(local, LOCAL_BOX, "/root/lkdef/lk/link.txt"),
        &box_state(serve, SERVE_BOX, "/root/lkdef/lk/link.txt"),
    );

    // 5b. --follow-symlinks → the link is dereferenced into a regular file.
    run(
        local,
        &["exec", LOCAL_BOX, "--", "mkdir", "-p", "/root/lkfol"],
    );
    run(
        serve,
        &["exec", SERVE_BOX, "--", "mkdir", "-p", "/root/lkfol"],
    );
    run(
        local,
        &[
            "cp",
            "--follow-symlinks",
            &lks,
            &at(LOCAL_BOX, "/root/lkfol"),
        ],
    );
    run(
        serve,
        &[
            "cp",
            "--follow-symlinks",
            &lks,
            &at(SERVE_BOX, "/root/lkfol"),
        ],
    );
    parity.check(
        "copy_in --follow-symlinks dereferences link",
        "file:data",
        &box_state(local, LOCAL_BOX, "/root/lkfol/lk/link.txt"),
        &box_state(serve, SERVE_BOX, "/root/lkfol/lk/link.txt"),
    );

    // === copy_out ===========================================================
    eprintln!("== copy_out scenarios ==");

    // 6. box file → nonexistent host path → regular file at the exact path (F-010).
    run(
        local,
        &[
            "exec",
            LOCAL_BOX,
            "--",
            "/bin/sh",
            "-c",
            "printf boxdata >/root/out.txt",
        ],
    );
    run(
        serve,
        &[
            "exec",
            SERVE_BOX,
            "--",
            "/bin/sh",
            "-c",
            "printf boxdata >/root/out.txt",
        ],
    );
    let h_local = work.join("out_local.txt");
    let h_serve = work.join("out_serve.txt");
    run(
        local,
        &[
            "cp",
            &at(LOCAL_BOX, "/root/out.txt"),
            &h_local.display().to_string(),
        ],
    );
    run(
        serve,
        &[
            "cp",
            &at(SERVE_BOX, "/root/out.txt"),
            &h_serve.display().to_string(),
        ],
    );
    parity.check(
        "copy_out file→nonexistent host is file",
        "file:boxdata",
        &host_state(&h_local),
        &host_state(&h_serve),
    );

    // 7. box dir, include_parent=false → host gets flattened contents.
    run(
        local,
        &[
            "exec",
            LOCAL_BOX,
            "--",
            "/bin/sh",
            "-c",
            "mkdir -p /root/od && printf z >/root/od/z.txt",
        ],
    );
    run(
        serve,
        &[
            "exec",
            SERVE_BOX,
            "--",
            "/bin/sh",
            "-c",
            "mkdir -p /root/od && printf z >/root/od/z.txt",
        ],
    );
    let hd_local = work.join("od_local");
    let hd_serve = work.join("od_serve");
    fs::create_dir(&hd_local).unwrap();
    fs::create_dir(&hd_serve).unwrap();
    run(
        local,
        &[
            "cp",
            "--no-include-parent",
            &at(LOCAL_BOX, "/root/od"),
            &hd_local.display().to_string(),
        ],
    );
    run(
        serve,
        &[
            "cp",
            "--no-include-parent",
            &at(SERVE_BOX, "/root/od"),
            &hd_serve.display().to_string(),
        ],
    );
    parity.check(
        "copy_out dir include_parent=false flattens",
        "file:z",
        &host_state(&hd_local.join("z.txt")),
        &host_state(&hd_serve.join("z.txt")),
    );

    // 8. box dir, default include_parent=true → host keeps the source dir name.
    run(
        local,
        &[
            "exec",
            LOCAL_BOX,
            "--",
            "/bin/sh",
            "-c",
            "mkdir -p /root/op && printf y >/root/op/y.txt",
        ],
    );
    run(
        serve,
        &[
            "exec",
            SERVE_BOX,
            "--",
            "/bin/sh",
            "-c",
            "mkdir -p /root/op && printf y >/root/op/y.txt",
        ],
    );
    let hp_local = work.join("op_local");
    let hp_serve = work.join("op_serve");
    fs::create_dir(&hp_local).unwrap();
    fs::create_dir(&hp_serve).unwrap();
    run(
        local,
        &[
            "cp",
            &at(LOCAL_BOX, "/root/op"),
            &hp_local.display().to_string(),
        ],
    );
    run(
        serve,
        &[
            "cp",
            &at(SERVE_BOX, "/root/op"),
            &hp_serve.display().to_string(),
        ],
    );
    parity.check(
        "copy_out dir include_parent=true keeps dirname",
        "file:y",
        &host_state(&hp_local.join("op/y.txt")),
        &host_state(&hp_serve.join("op/y.txt")),
    );

    // 9. --no-overwrite → existing host file is left unchanged.
    run(
        local,
        &[
            "exec",
            LOCAL_BOX,
            "--",
            "/bin/sh",
            "-c",
            "printf boxnew >/root/ow.txt",
        ],
    );
    run(
        serve,
        &[
            "exec",
            SERVE_BOX,
            "--",
            "/bin/sh",
            "-c",
            "printf boxnew >/root/ow.txt",
        ],
    );
    // Prove the box source is present, so the refusal below is the overwrite
    // rejection — not a missing-source error riding on the pre-seeded host file.
    parity.check(
        "copy_out --no-overwrite: box source present",
        "file:boxnew",
        &box_state(local, LOCAL_BOX, "/root/ow.txt"),
        &box_state(serve, SERVE_BOX, "/root/ow.txt"),
    );
    let ow_local = work.join("ow_local.txt");
    let ow_serve = work.join("ow_serve.txt");
    fs::write(&ow_local, "hostold").unwrap();
    fs::write(&ow_serve, "hostold").unwrap();
    let local_reject = run(
        local,
        &[
            "cp",
            "--no-overwrite",
            &at(LOCAL_BOX, "/root/ow.txt"),
            &ow_local.display().to_string(),
        ],
    );
    let serve_reject = run(
        serve,
        &[
            "cp",
            "--no-overwrite",
            &at(SERVE_BOX, "/root/ow.txt"),
            &ow_serve.display().to_string(),
        ],
    );
    parity.check_both_fail(
        "copy_out --no-overwrite rejects",
        local_reject.success,
        serve_reject.success,
    );
    parity.check(
        "copy_out --no-overwrite leaves host file",
        "file:hostold",
        &host_state(&ow_local),
        &host_state(&ow_serve),
    );

    // 10. follow_symlinks (box → host): default preserves the link, --follow-symlinks derefs.
    let make_link = "mkdir -p /root/lkb && printf data >/root/lkb/target.txt \
                     && ln -sf target.txt /root/lkb/link.txt";
    run(
        local,
        &["exec", LOCAL_BOX, "--", "/bin/sh", "-c", make_link],
    );
    run(
        serve,
        &["exec", SERVE_BOX, "--", "/bin/sh", "-c", make_link],
    );

    // 10a. default preserves the symlink.
    let lb_local = work.join("lkb_local");
    let lb_serve = work.join("lkb_serve");
    fs::create_dir(&lb_local).unwrap();
    fs::create_dir(&lb_serve).unwrap();
    run(
        local,
        &[
            "cp",
            &at(LOCAL_BOX, "/root/lkb"),
            &lb_local.display().to_string(),
        ],
    );
    run(
        serve,
        &[
            "cp",
            &at(SERVE_BOX, "/root/lkb"),
            &lb_serve.display().to_string(),
        ],
    );
    parity.check(
        "copy_out default preserves symlink",
        "symlink:target.txt",
        &host_state(&lb_local.join("lkb/link.txt")),
        &host_state(&lb_serve.join("lkb/link.txt")),
    );

    // 10b. --follow-symlinks dereferences the link into a regular file.
    let lbf_local = work.join("lkbf_local");
    let lbf_serve = work.join("lkbf_serve");
    fs::create_dir(&lbf_local).unwrap();
    fs::create_dir(&lbf_serve).unwrap();
    run(
        local,
        &[
            "cp",
            "--follow-symlinks",
            &at(LOCAL_BOX, "/root/lkb"),
            &lbf_local.display().to_string(),
        ],
    );
    run(
        serve,
        &[
            "cp",
            "--follow-symlinks",
            &at(SERVE_BOX, "/root/lkb"),
            &lbf_serve.display().to_string(),
        ],
    );
    parity.check(
        "copy_out --follow-symlinks dereferences link",
        "file:data",
        &host_state(&lbf_local.join("lkb/link.txt")),
        &host_state(&lbf_serve.join("lkb/link.txt")),
    );
}
