//! A `boxlite serve` child process, shared by the REST end-to-end tests.

#![allow(dead_code)]

use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// A `boxlite serve` child, torn down (gracefully) when dropped.
pub struct ServeChild {
    child: Child,
    port: u16,
    // Serve's own home. Dropped *after* the child is signalled, so its boxes are
    // already stopped and the leaked-shim assertion in PerTestBoxHome's Drop is
    // satisfied.
    _home: boxlite_test_utils::home::PerTestBoxHome,
}

impl ServeChild {
    pub fn start() -> Self {
        let home = boxlite_test_utils::home::PerTestBoxHome::new();

        // Ask the OS for a free port, then release it — a small race with
        // whatever binds next, but the standard trick and good enough here.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .expect("bind ephemeral")
            .local_addr()
            .unwrap()
            .port();

        let mut cmd = Command::new(env!("CARGO_BIN_EXE_boxlite"));
        cmd.arg("--home").arg(&home.path);
        for reg in boxlite_test_utils::TEST_REGISTRIES {
            cmd.arg("--registry").arg(reg);
        }
        cmd.args(["serve", "--host", "127.0.0.1", "--port", &port.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        let child = cmd.spawn().expect("spawn boxlite serve");
        let serve = Self {
            child,
            port,
            _home: home,
        };
        serve.wait_ready();
        serve
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// Run a `boxlite --url` client command against this server.
    pub fn client(&self, args: &[&str]) -> std::process::Output {
        Command::new(env!("CARGO_BIN_EXE_boxlite"))
            .args(["--url", &self.url()])
            .args(args)
            .output()
            .expect("boxlite --url")
    }

    /// Wait until the server reports no boxes.
    ///
    /// A box's teardown over REST is asynchronous — the main command exits, the
    /// guest powers the VM off, the server's watcher notices and (for `--rm`)
    /// removes it, all a beat after the client's `run` returns. Killing the
    /// server while a box is still in that window would leak its shim, since the
    /// server only runs its stop-everything path on SIGINT, not the SIGKILL a
    /// dropped child gets. So drain first.
    pub fn wait_until_no_boxes(&self) {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let out = self.client(&["ps", "-a"]);
            let listed = String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter(|l| l.contains("alpine"))
                .count();
            if out.status.success() && listed == 0 {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "server still has {listed} box(es) after the run — they never stopped"
            );
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    /// Poll a real HTTP call (`ps`) until serve answers — a bound socket is not
    /// the same as a router that serves.
    pub fn wait_ready(&self) {
        let deadline = Instant::now() + Duration::from_secs(45);
        while Instant::now() < deadline {
            if TcpStream::connect(("127.0.0.1", self.port)).is_ok() {
                let ok = Command::new(env!("CARGO_BIN_EXE_boxlite"))
                    .args(["--url", &self.url(), "ps"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false);
                if ok {
                    return;
                }
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        panic!("boxlite serve did not become ready on port {}", self.port);
    }
}

impl Drop for ServeChild {
    fn drop(&mut self) {
        // SIGINT: it is the signal serve wires to graceful shutdown
        // (`with_graceful_shutdown(ctrl_c())`). The tests drain their boxes
        // first, so this is just to end the process cleanly; a SIGKILL fallback
        // below covers a serve that ignores it.
        let pid = self.child.id().to_string();
        let _ = Command::new("kill").args(["-s", "INT", &pid]).status();

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match self.child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(100));
                }
                _ => {
                    let _ = self.child.kill();
                    let _ = self.child.wait();
                    break;
                }
            }
        }
    }
}
