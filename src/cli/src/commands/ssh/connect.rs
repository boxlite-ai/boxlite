//! Keep the runtime's tunnel alive until the system OpenSSH client is reaped.

use std::fs;
use std::io::{IsTerminal, Write};
use std::net::SocketAddr;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use boxlite::{LiteBox, SocketAddress, SshStatus, TunnelForwarder};
use futures::FutureExt;
use nix::errno::Errno;
use nix::sys::signal::{Signal as UnixSignal, kill};
use nix::sys::termios::{SetArg, Termios, tcgetattr, tcsetattr};
use nix::unistd::Pid;
use tokio::process::{Child, Command};
use tokio::signal::unix::{Signal, SignalKind, signal};
use tokio::time::timeout;

pub(super) struct ConnectionPaths {
    identity: String,
    known_hosts: String,
    known_hosts_path: PathBuf,
}

impl ConnectionPaths {
    pub(super) fn new(directory: &Path) -> Result<Self> {
        let identity = ssh_config_path(&directory.join("client_key"))?;
        let known_hosts_path = directory.join("known_hosts");
        let known_hosts = ssh_config_path(&known_hosts_path)?;
        Ok(Self {
            identity,
            known_hosts,
            known_hosts_path,
        })
    }
}

pub(super) async fn execute(
    sandbox: &LiteBox,
    status: &SshStatus,
    paths: ConnectionPaths,
    host_alias: &str,
    expected_host_key: &str,
) -> Result<i32> {
    write_known_hosts(&paths.known_hosts_path, host_alias, expected_host_key)?;

    let mut signals = TerminationSignals::new()?;
    let _terminal = TerminalRestore::capture()?;
    let tunnel = tokio::select! {
        biased;
        received = signals.recv() => return Ok(128 + received as i32),
        tunnel = super::ssh_tunnel(sandbox, status) => tunnel?,
    };
    let forwarder = tunnel
        .forward(SocketAddress::Tcp(SocketAddr::from(([127, 0, 0, 1], 0))))
        .await
        .context("forward guest SSH to loopback")?;

    // All fallible work after binding stays inside this call so even spawn
    // failures take the same awaited forwarding cleanup path.
    let result = run_session(
        &forwarder,
        &paths.identity,
        &paths.known_hosts,
        host_alias,
        &mut signals,
    )
    .await;
    if let Err(error) = forwarder
        .close()
        .await
        .context("close SSH tunnel forwarder")
    {
        if matches!(&result, Ok(0)) {
            return Err(error);
        }
        eprintln!("SSH cleanup failed: {error:#}");
    }
    result
}

fn ssh_config_path(path: &Path) -> Result<String> {
    let value = path.to_str().context("SSH command paths must be UTF-8")?;
    if value.chars().any(char::is_control) || value.contains("${") {
        bail!(
            "SSH command paths cannot contain control characters or ${{: {}",
            path.display()
        );
    }

    // These quotes belong to ssh_config parsing, not to a shell. Percent
    // tokens must remain literal when OpenSSH expands the file path.
    let mut encoded = String::with_capacity(value.len() + 2);
    encoded.push('"');
    for character in value.chars() {
        match character {
            '\\' | '"' => encoded.push('\\'),
            '%' => encoded.push('%'),
            _ => {}
        }
        encoded.push(character);
    }
    encoded.push('"');
    Ok(encoded)
}

fn write_known_hosts(path: &Path, host_alias: &str, expected_host_key: &str) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => super::setup::check_private(path, false)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("inspect SSH known_hosts file"),
    }

    let mut fields = expected_host_key.split_whitespace();
    let algorithm = fields
        .next()
        .context("missing managed SSH host key algorithm")?;
    let key = fields
        .next()
        .context("missing managed SSH host public key")?;
    let directory = path
        .parent()
        .context("SSH known_hosts path has no parent")?;
    let mut temporary = tempfile::NamedTempFile::new_in(directory)
        .context("create private SSH known_hosts file")?;
    temporary
        .as_file()
        .set_permissions(fs::Permissions::from_mode(0o600))
        .context("protect SSH known_hosts file")?;
    writeln!(temporary, "{host_alias} {algorithm} {key}").context("write SSH known_hosts file")?;
    temporary
        .as_file()
        .sync_all()
        .context("save SSH known_hosts file")?;
    temporary
        .persist(path)
        .context("install SSH known_hosts file")?;
    Ok(())
}

async fn run_session(
    forwarder: &TunnelForwarder,
    identity: &str,
    known_hosts: &str,
    host_alias: &str,
    signals: &mut TerminationSignals,
) -> Result<i32> {
    // A signal may have arrived while binding the listener; do not spawn
    // OpenSSH merely to terminate it for an already queued cancellation.
    if let Some(received) = signals.recv().now_or_never() {
        return Ok(128 + received as i32);
    }
    let port = match forwarder.local_addr() {
        SocketAddress::Tcp(address) => address.port(),
        SocketAddress::Unix(_) => bail!("SSH tunnel forwarder did not bind a TCP address"),
    };
    let mut child = Command::new("ssh")
        .args([
            "-F",
            "/dev/null",
            "-o",
            "BatchMode=yes",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "IdentityAgent=none",
            "-o",
            "StrictHostKeyChecking=yes",
            "-o",
            "GlobalKnownHostsFile=/dev/null",
        ])
        .arg("-o")
        .arg(format!("UserKnownHostsFile={known_hosts}"))
        .arg("-o")
        .arg(format!("IdentityFile={identity}"))
        .arg("-o")
        .arg(format!("HostKeyAlias={host_alias}"))
        .args([
            "-o",
            "UpdateHostKeys=no",
            "-o",
            "ControlMaster=no",
            "-o",
            "ControlPath=none",
            "-o",
            "ConnectTimeout=15",
            "-p",
        ])
        .arg(port.to_string())
        .args(["-l", "box", "127.0.0.1"])
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .context("start system OpenSSH client")?;

    let (result, shutdown_signal) = tokio::select! {
        biased;
        received = signals.recv() => (Ok(128 + received as i32), Some(received)),
        status = child.wait() => match status {
            Ok(status) => (exit_code(status), None),
            Err(error) => (
                Err(error).context("wait for system OpenSSH client"),
                Some(UnixSignal::SIGTERM),
            ),
        },
        forwarded = forwarder.wait() => {
            let error = match forwarded {
                Ok(()) => anyhow!("SSH tunnel forwarder stopped before the SSH client exited"),
                Err(error) => anyhow!(error).context("SSH tunnel forwarder failed"),
            };
            (Err(error), Some(UnixSignal::SIGTERM))
        },
    };
    if let Some(signal) = shutdown_signal {
        // The primary result is already an error or nonzero signal exit code;
        // shutdown diagnostics must not replace it or close forwarding early.
        terminate_and_reap(&mut child, signal).await;
    }
    result
}

fn exit_code(status: ExitStatus) -> Result<i32> {
    status
        .code()
        .or_else(|| status.signal().map(|signal| 128 + signal))
        .context("OpenSSH exited without an exit code or termination signal")
}

async fn terminate_and_reap(child: &mut Child, signal: UnixSignal) {
    if let Some(pid) = child.id()
        && let Err(error) = kill(Pid::from_raw(pid as i32), signal)
        && error != Errno::ESRCH
    {
        eprintln!("Failed to send {signal} to OpenSSH: {error}");
    }

    match timeout(Duration::from_secs(5), child.wait()).await {
        Ok(Ok(_)) => return,
        Ok(Err(error)) => eprintln!("Failed to wait for OpenSSH during shutdown: {error}"),
        Err(_) => {}
    }

    // Await reaping even if requesting SIGKILL fails; the child may already
    // have exited between the timeout and the kill attempt.
    if let Err(error) = child.start_kill() {
        eprintln!("Failed to kill OpenSSH during shutdown: {error}");
    }
    if let Err(error) = child.wait().await {
        eprintln!("Failed to reap OpenSSH during shutdown: {error}");
    }
}

struct TerminationSignals {
    interrupt: Signal,
    terminate: Signal,
    hangup: Signal,
    quit: Signal,
}

impl TerminationSignals {
    fn new() -> Result<Self> {
        Ok(Self {
            interrupt: signal(SignalKind::interrupt()).context("register SSH SIGINT handler")?,
            terminate: signal(SignalKind::terminate()).context("register SSH SIGTERM handler")?,
            hangup: signal(SignalKind::hangup()).context("register SSH SIGHUP handler")?,
            quit: signal(SignalKind::quit()).context("register SSH SIGQUIT handler")?,
        })
    }

    async fn recv(&mut self) -> UnixSignal {
        tokio::select! {
            _ = self.interrupt.recv() => UnixSignal::SIGINT,
            _ = self.terminate.recv() => UnixSignal::SIGTERM,
            _ = self.hangup.recv() => UnixSignal::SIGHUP,
            _ = self.quit.recv() => UnixSignal::SIGQUIT,
        }
    }
}

struct TerminalRestore {
    original: Option<Termios>,
}

impl TerminalRestore {
    fn capture() -> Result<Self> {
        let stdin = std::io::stdin();
        let original = if stdin.is_terminal() {
            Some(tcgetattr(&stdin).context("capture terminal settings before OpenSSH")?)
        } else {
            None
        };
        Ok(Self { original })
    }
}

impl Drop for TerminalRestore {
    fn drop(&mut self) {
        if let Some(original) = &self.original
            && let Err(error) = tcsetattr(std::io::stdin(), SetArg::TCSANOW, original)
        {
            eprintln!("Failed to restore terminal settings after OpenSSH: {error}");
        }
    }
}
