//! End-to-end tests: a real `russh::client` connected over an in-memory
//! duplex to a real `SshConnection`, with no socket and no VM -- certificate
//! authentication, shell/exec/PTY/resize, exit-status conventions, disconnect
//! cleanup, and resource limits.

use super::bridge;
use super::ca::{test_support, SshTrust, SSH_LOGIN_USER};
use super::limits::MAX_CHANNELS_PER_CONNECTION;
use super::server::{self, SshConnection};
use crate::layout::GuestLayout;
use crate::service::server::GuestServer;
use russh::client::{AuthResult, Handle as ClientHandle};
use russh::keys::key::PrivateKeyWithHashAlg;
use russh::keys::ssh_key::Certificate;
use russh::keys::PrivateKey;
use russh::server::run_stream;
use russh::ChannelMsg;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

const TEST_TIMEOUT: Duration = Duration::from_secs(30);

struct TestClientHandler;

impl russh::client::Handler for TestClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKey,
    ) -> Result<bool, Self::Error> {
        // Test harness only -- production callers verify against the
        // fingerprint the Hosted API returned, exactly like standard
        // OpenSSH known_hosts.
        Ok(true)
    }
}

struct TestServer {
    _tmp: tempfile::TempDir,
    guest: Arc<GuestServer>,
    /// The organization CA this box's VM generation trusts.
    ca: PrivateKey,
    trust: Arc<SshTrust>,
}

impl TestServer {
    /// Mint a certificate this box should accept.
    fn valid_cert(&self, user_key: &PrivateKey) -> Certificate {
        test_support::sign_cert(
            &self.ca,
            user_key,
            &test_support::default_principals(),
            SystemTime::now() - Duration::from_secs(30),
            SystemTime::now() + Duration::from_secs(300),
        )
    }
}

/// A single, process-lifetime tokio runtime shared by every test in this
/// module -- matching production, where `main.rs` builds exactly one
/// `tokio::runtime::Runtime` for the whole guest agent process.
///
/// This matters beyond convenience: `GuestExecutor` registers every spawned
/// process's exit slot with the guest-wide reaper (`service::exec`'s
/// `spawn_execution`), and the reaper's `SIGCHLD` watch loop is tied to
/// whichever runtime it was spawned on. A plain `#[tokio::test]` gives each
/// test its *own*, disposable runtime -- the reaper (a process-wide
/// `OnceLock`) would end up attached to whichever test happened to install
/// it first, and every other test's spawned processes would never be
/// reaped, hanging any assertion that waits on one exiting.
fn shared_runtime() -> &'static tokio::runtime::Runtime {
    static RT: std::sync::OnceLock<tokio::runtime::Runtime> = std::sync::OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("build shared test runtime")
    })
}

fn ensure_reaper_installed() {
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        let _ = crate::reaper::REAPER.set(crate::reaper::Reaper::install());
    });
}

async fn start_test_server() -> TestServer {
    // Quiet by default; set RUST_LOG to see it (useful when a test hangs).
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .try_init();
    ensure_reaper_installed();
    let tmp = tempfile::tempdir().unwrap();
    let layout = GuestLayout::with_base(tmp.path());
    let guest = Arc::new(GuestServer::new(layout));
    let ca = test_support::generate_ed25519();
    let trust = Arc::new(test_support::trust_for(&[test_support::ca_key_line(
        &ca, "ca-key-1",
    )]));
    TestServer {
        _tmp: tmp,
        guest,
        ca,
        trust,
    }
}

/// Connect a fresh client/server pair over an in-memory duplex and complete
/// certificate authentication. Panics if auth doesn't succeed -- callers that
/// want to observe an auth *failure* should use [`try_connect_and_auth`].
async fn connect_and_auth(
    env: &TestServer,
    client_key: &PrivateKey,
    cert: Certificate,
) -> ClientHandle<TestClientHandler> {
    let (handle, result) = try_connect_and_auth(env, SSH_LOGIN_USER, client_key, cert).await;
    assert!(
        matches!(result, AuthResult::Success),
        "expected auth success"
    );
    handle
}

async fn try_connect_and_auth(
    env: &TestServer,
    user: &str,
    client_key: &PrivateKey,
    cert: Certificate,
) -> (ClientHandle<TestClientHandler>, AuthResult) {
    let mut client = connect_without_authenticating(env).await;

    let auth = tokio::time::timeout(
        TEST_TIMEOUT,
        client.authenticate_openssh_cert(user, Arc::new(client_key.clone()), cert),
    )
    .await
    .expect("auth timed out")
    .expect("auth transport error");

    (client, auth)
}

/// Completes the transport handshake only, leaving authentication to the
/// caller -- used by tests that probe non-certificate auth methods (`none`,
/// `password`, raw public key).
async fn connect_without_authenticating(env: &TestServer) -> ClientHandle<TestClientHandler> {
    let (client_io, server_io) = tokio::io::duplex(1 << 20);

    let host_key = PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap();
    let server_config = Arc::new(server::build_config(host_key));
    let execution_client = bridge::connect_execution_client(env.guest.clone())
        .await
        .unwrap();
    let handler = SshConnection::new(env.guest.clone(), env.trust.clone(), execution_client);

    tokio::spawn(async move {
        match run_stream(server_config, server_io, handler).await {
            Ok(running) => {
                let _ = running.await;
            }
            Err(e) => tracing::debug!(error = %e, "test server session setup failed"),
        }
    });

    let client_config = Arc::new(russh::client::Config::default());
    russh::client::connect_stream(client_config, client_io, TestClientHandler)
        .await
        .expect("client handshake failed")
}

async fn read_line(channel: &mut russh::Channel<russh::client::Msg>) -> String {
    let mut buf = Vec::new();
    loop {
        match tokio::time::timeout(TEST_TIMEOUT, channel.wait())
            .await
            .unwrap()
        {
            Some(ChannelMsg::Data { data }) => {
                buf.extend_from_slice(&data);
                if buf.contains(&b'\n') {
                    break;
                }
            }
            Some(_) => continue,
            None => break,
        }
    }
    String::from_utf8_lossy(&buf).trim().to_string()
}

/// Accumulate `Data` bytes until `needle` appears in the running transcript.
/// Bounded by `TEST_TIMEOUT` overall (not per-message), so a stream that
/// never produces the expected text fails the test instead of hanging.
async fn read_until_contains(
    channel: &mut russh::Channel<russh::client::Msg>,
    needle: &str,
) -> String {
    let mut buf = Vec::new();
    tokio::time::timeout(TEST_TIMEOUT, async {
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    buf.extend_from_slice(&data);
                    if String::from_utf8_lossy(&buf).contains(needle) {
                        return;
                    }
                }
                Some(_) => continue,
                None => return,
            }
        }
    })
    .await
    .expect("timed out waiting for expected output");
    String::from_utf8_lossy(&buf).into_owned()
}

async fn drain_until_closed(
    channel: &mut russh::Channel<russh::client::Msg>,
) -> (Vec<u8>, Vec<u8>, Option<u32>) {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut exit_status = None;
    loop {
        match tokio::time::timeout(TEST_TIMEOUT, channel.wait())
            .await
            .unwrap()
        {
            Some(ChannelMsg::Data { data }) => stdout.extend_from_slice(&data),
            Some(ChannelMsg::ExtendedData { data, ext: 1 }) => stderr.extend_from_slice(&data),
            Some(ChannelMsg::ExitStatus { exit_status: code }) => exit_status = Some(code),
            Some(ChannelMsg::Close) | Some(ChannelMsg::Eof) => {}
            Some(_) => {}
            None => break,
        }
    }
    (stdout, stderr, exit_status)
}

fn pid_is_alive(pid: u32) -> bool {
    std::path::Path::new(&format!("/proc/{pid}")).exists()
}

// ---------------------------------------------------------------------
// 1. Certificate authentication
// ---------------------------------------------------------------------

#[test]
fn certificate_from_the_trusted_ca_authenticates_as_root() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;
        let key = test_support::generate_ed25519();
        let cert = env.valid_cert(&key);

        let _client = connect_and_auth(&env, &key, cert).await;
    });
}

#[test]
fn certificate_from_an_untrusted_ca_is_rejected() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;
        let attacker_ca = test_support::generate_ed25519();
        let key = test_support::generate_ed25519();
        let cert = test_support::sign_cert(
            &attacker_ca,
            &key,
            &test_support::default_principals(),
            SystemTime::now() - Duration::from_secs(30),
            SystemTime::now() + Duration::from_secs(300),
        );

        let (_client, result) = try_connect_and_auth(&env, SSH_LOGIN_USER, &key, cert).await;
        assert!(matches!(result, AuthResult::Failure { .. }));
    });
}

#[test]
fn certificate_bound_to_another_box_is_rejected() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;
        let key = test_support::generate_ed25519();
        let principals = vec![
            SSH_LOGIN_USER.to_string(),
            "box:box-99999999".to_string(),
            format!("org:{}", test_support::TEST_ORG_ID),
        ];
        let cert = test_support::sign_cert(
            &env.ca,
            &key,
            &principals,
            SystemTime::now() - Duration::from_secs(30),
            SystemTime::now() + Duration::from_secs(300),
        );

        let (_client, result) = try_connect_and_auth(&env, SSH_LOGIN_USER, &key, cert).await;
        assert!(matches!(result, AuthResult::Failure { .. }));
    });
}

#[test]
fn certificate_bound_to_another_organization_is_rejected() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;
        let key = test_support::generate_ed25519();
        let principals = vec![
            SSH_LOGIN_USER.to_string(),
            format!("box:{}", test_support::TEST_BOX_ID),
            "org:org-99999999".to_string(),
        ];
        let cert = test_support::sign_cert(
            &env.ca,
            &key,
            &principals,
            SystemTime::now() - Duration::from_secs(30),
            SystemTime::now() + Duration::from_secs(300),
        );

        let (_client, result) = try_connect_and_auth(&env, SSH_LOGIN_USER, &key, cert).await;
        assert!(matches!(result, AuthResult::Failure { .. }));
    });
}

#[test]
fn expired_certificate_is_rejected() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;
        let key = test_support::generate_ed25519();
        let cert = test_support::sign_cert(
            &env.ca,
            &key,
            &test_support::default_principals(),
            SystemTime::now() - Duration::from_secs(600),
            SystemTime::now() - Duration::from_secs(300),
        );

        let (_client, result) = try_connect_and_auth(&env, SSH_LOGIN_USER, &key, cert).await;
        assert!(matches!(result, AuthResult::Failure { .. }));
    });
}

#[test]
fn not_yet_valid_certificate_is_rejected() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;
        let key = test_support::generate_ed25519();
        let cert = test_support::sign_cert(
            &env.ca,
            &key,
            &test_support::default_principals(),
            SystemTime::now() + Duration::from_secs(300),
            SystemTime::now() + Duration::from_secs(600),
        );

        let (_client, result) = try_connect_and_auth(&env, SSH_LOGIN_USER, &key, cert).await;
        assert!(matches!(result, AuthResult::Failure { .. }));
    });
}

#[test]
fn certificate_presented_for_a_non_root_user_is_rejected() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;
        let key = test_support::generate_ed25519();
        let cert = env.valid_cert(&key);

        let (_client, result) = try_connect_and_auth(&env, "someone-else", &key, cert).await;
        assert!(matches!(result, AuthResult::Failure { .. }));
    });
}

#[test]
fn raw_public_key_auth_is_always_rejected() {
    // Design invariant: authority comes only from a CA signature. A bare key
    // -- even the very key a valid certificate binds -- is not a credential.
    shared_runtime().block_on(async {
        let env = start_test_server().await;
        let key = test_support::generate_ed25519();
        let _cert = env.valid_cert(&key);

        let mut client = connect_without_authenticating(&env).await;
        let key_with_alg = PrivateKeyWithHashAlg::new(Arc::new(key.clone()), None);
        let result = tokio::time::timeout(
            TEST_TIMEOUT,
            client.authenticate_publickey(SSH_LOGIN_USER, key_with_alg),
        )
        .await
        .expect("auth timed out")
        .expect("auth transport error");
        assert!(matches!(result, AuthResult::Failure { .. }));
    });
}

#[test]
fn none_auth_is_always_rejected() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;

        let mut client = connect_without_authenticating(&env).await;
        let result = tokio::time::timeout(TEST_TIMEOUT, client.authenticate_none(SSH_LOGIN_USER))
            .await
            .expect("auth timed out")
            .expect("auth transport error");
        assert!(matches!(result, AuthResult::Failure { .. }));
    });
}

#[test]
fn password_auth_is_always_rejected() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;

        let mut client = connect_without_authenticating(&env).await;
        let result = tokio::time::timeout(
            TEST_TIMEOUT,
            client.authenticate_password(SSH_LOGIN_USER, "hunter2"),
        )
        .await
        .expect("auth timed out")
        .expect("auth transport error");
        assert!(matches!(result, AuthResult::Failure { .. }));
    });
}

// ---------------------------------------------------------------------
// 2/3. Exec / shell / PTY / resize / binary output / exit codes
// ---------------------------------------------------------------------

async fn authed_client(env: &TestServer) -> ClientHandle<TestClientHandler> {
    let key = test_support::generate_ed25519();
    let cert = env.valid_cert(&key);
    connect_and_auth(env, &key, cert).await
}

#[test]
fn exec_delegates_and_reports_exit_status() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;
        let client = authed_client(&env).await;

        let mut channel = client.channel_open_session().await.unwrap();
        channel.exec(true, &b"exit 7"[..]).await.unwrap();
        let (_stdout, _stderr, exit_status) = drain_until_closed(&mut channel).await;
        assert_eq!(exit_status, Some(7));
    });
}

#[test]
fn exec_output_is_binary_safe() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;
        let client = authed_client(&env).await;

        let mut channel = client.channel_open_session().await.unwrap();
        // printf a byte range including NUL and high bytes.
        channel
            .exec(true, &b"printf '\\000\\001\\002\\377\\376'"[..])
            .await
            .unwrap();
        let (stdout, _stderr, exit_status) = drain_until_closed(&mut channel).await;
        assert_eq!(stdout, vec![0u8, 1, 2, 0xff, 0xfe]);
        assert_eq!(exit_status, Some(0));
    });
}

#[test]
fn stderr_is_routed_as_extended_data() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;
        let client = authed_client(&env).await;

        let mut channel = client.channel_open_session().await.unwrap();
        channel
            .exec(true, &b"echo out; echo err 1>&2"[..])
            .await
            .unwrap();
        let (stdout, stderr, _exit) = drain_until_closed(&mut channel).await;
        assert_eq!(String::from_utf8_lossy(&stdout).trim(), "out");
        assert_eq!(String::from_utf8_lossy(&stderr).trim(), "err");
    });
}

#[test]
fn signal_death_is_reported_as_exit_status_128_plus_signal() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;
        let client = authed_client(&env).await;

        let mut channel = client.channel_open_session().await.unwrap();
        channel.exec(true, &b"kill -TERM $$"[..]).await.unwrap();
        let (_stdout, _stderr, exit_status) = drain_until_closed(&mut channel).await;
        assert_eq!(exit_status, Some(128 + 15), "SIGTERM (15) => 143");
    });
}

#[test]
fn shell_with_pty_delegates_tty_and_window_change_resizes() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;
        let client = authed_client(&env).await;

        let mut channel = client.channel_open_session().await.unwrap();
        channel
            .request_pty(true, "xterm", 80, 24, 0, 0, &[])
            .await
            .unwrap();
        channel.request_shell(true).await.unwrap();

        // A PTY echoes what was typed and the shell may print its own prompt,
        // so match `stty size`'s output as a substring of the accumulated
        // transcript rather than assuming an exact line -- the noise around it
        // is shell-dependent, not something this test should pin down.
        channel.data_bytes(b"stty size\n".to_vec()).await.unwrap();
        let initial = read_until_contains(&mut channel, "24 80").await;
        assert!(
            initial.contains("24 80"),
            "PTY rows/cols should reach the shell, got: {initial:?}"
        );

        // Resize *after* confirming the initial size arrived, and check it via
        // a second `stty size` -- resizing first and reusing one transcript
        // races the ioctl against the shell processing the original command.
        channel.window_change(100, 40, 0, 0).await.unwrap();
        channel
            .data_bytes(b"stty size; exit\n".to_vec())
            .await
            .unwrap();
        let (stdout, _stderr, _exit) = drain_until_closed(&mut channel).await;
        let transcript = String::from_utf8_lossy(&stdout);
        assert!(
            transcript.contains("40 100"),
            "window_change resize should reach the shell, got: {transcript:?}"
        );
    });
}

#[test]
fn stdin_is_forwarded_then_closed_on_eof() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;
        let client = authed_client(&env).await;

        let mut channel = client.channel_open_session().await.unwrap();
        channel.exec(true, &b"cat"[..]).await.unwrap();
        channel
            .data_bytes(b"hello\xffworld".to_vec())
            .await
            .unwrap();
        channel.eof().await.unwrap();

        let (stdout, _stderr, exit_status) = drain_until_closed(&mut channel).await;
        assert_eq!(stdout, b"hello\xffworld");
        assert_eq!(exit_status, Some(0));
    });
}

#[test]
fn concurrent_channels_get_distinct_executions_and_routed_output() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;
        let client = authed_client(&env).await;

        let mut a = client.channel_open_session().await.unwrap();
        a.exec(true, &b"echo A"[..]).await.unwrap();
        let mut b = client.channel_open_session().await.unwrap();
        b.exec(true, &b"echo B"[..]).await.unwrap();

        let (a_out, _, a_exit) = drain_until_closed(&mut a).await;
        let (b_out, _, b_exit) = drain_until_closed(&mut b).await;
        assert_eq!(String::from_utf8_lossy(&a_out).trim(), "A");
        assert_eq!(String::from_utf8_lossy(&b_out).trim(), "B");
        assert_eq!(a_exit, Some(0));
        assert_eq!(b_exit, Some(0));
    });
}

// ---------------------------------------------------------------------
// 4. Unsupported requests
// ---------------------------------------------------------------------

#[test]
fn unsupported_requests_fail_cleanly_and_connection_survives() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;
        let client = authed_client(&env).await;

        let mut sftp_impostor = client.channel_open_session().await.unwrap();
        sftp_impostor
            .request_subsystem(true, "not-sftp")
            .await
            .unwrap();
        match tokio::time::timeout(TEST_TIMEOUT, sftp_impostor.wait())
            .await
            .unwrap()
        {
            Some(ChannelMsg::Failure) => {}
            other => panic!("expected Failure for unsupported subsystem, got {other:?}"),
        }

        // A normal exec on a fresh channel of the same connection still works.
        let mut channel = client.channel_open_session().await.unwrap();
        channel.exec(true, &b"echo still-alive"[..]).await.unwrap();
        let (stdout, _, exit_status) = drain_until_closed(&mut channel).await;
        assert_eq!(String::from_utf8_lossy(&stdout).trim(), "still-alive");
        assert_eq!(exit_status, Some(0));
    });
}

// ---------------------------------------------------------------------
// 5. Disconnect cleanup (regression coverage for the reference branch's
//    wedged-process leak: kill must not depend on the Attach stream ending
//    cleanly).
// ---------------------------------------------------------------------

#[test]
fn client_disconnect_kills_running_execution() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;
        let client = authed_client(&env).await;

        let mut channel = client.channel_open_session().await.unwrap();
        channel
            .exec(true, &b"echo $$; sleep 100"[..])
            .await
            .unwrap();
        let pid: u32 = read_line(&mut channel).await.parse().expect("pid line");
        assert!(
            pid_is_alive(pid),
            "test process should be running before disconnect"
        );

        // `russh::client::Handle`'s `Drop` is a no-op (by design -- it doesn't
        // own the transport); a real client disconnect is either an explicit
        // SSH disconnect message or the transport closing (e.g. TCP RST). Send
        // the former, since the in-memory duplex has no transport-level EOF
        // signal of its own.
        drop(channel);
        client
            .disconnect(russh::Disconnect::ByApplication, "", "")
            .await
            .unwrap();
        drop(client);

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while pid_is_alive(pid) && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            !pid_is_alive(pid),
            "process must be killed after client disconnect"
        );
    });
}

#[test]
fn channel_close_kills_running_execution_without_closing_connection() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;
        let client = authed_client(&env).await;

        let mut channel = client.channel_open_session().await.unwrap();
        channel
            .exec(true, &b"echo $$; sleep 100"[..])
            .await
            .unwrap();
        let pid: u32 = read_line(&mut channel).await.parse().expect("pid line");

        channel.close().await.unwrap();

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while pid_is_alive(pid) && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(!pid_is_alive(pid));

        // Connection itself must still be usable.
        let mut next = client.channel_open_session().await.unwrap();
        next.exec(true, &b"echo ok"[..]).await.unwrap();
        let (stdout, _, exit) = drain_until_closed(&mut next).await;
        assert_eq!(String::from_utf8_lossy(&stdout).trim(), "ok");
        assert_eq!(exit, Some(0));
    });
}

// ---------------------------------------------------------------------
// 6. Resource limits
// ---------------------------------------------------------------------

/// A subsystem request must never free the channel's slot behind the client's
/// back.
///
/// `subsystem_request` used to remove the channel from `pending_channels`
/// before it could fail, and on success handed it to an untracked task — both
/// paths let `open_channel_count` fall while the client still held the
/// channel, so repeating the request opened unbounded channels past the cap.
/// This harness has no container, so it drives the failure path; the success
/// path is covered by `sftp_tasks` being summed in `open_channel_count`.
#[test]
fn a_subsystem_request_does_not_free_the_channel_slot() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;
        let client = authed_client(&env).await;

        let mut started = 0;
        let mut channels = Vec::new();
        for _ in 0..MAX_CHANNELS_PER_CONNECTION {
            let Ok(channel) = client.channel_open_session().await else {
                break;
            };
            if channel.request_subsystem(true, "sftp").await.is_err() {
                break;
            }
            started += 1;
            channels.push(channel);
        }

        assert_eq!(
            started, MAX_CHANNELS_PER_CONNECTION,
            "should be able to start SFTP up to the cap"
        );
        assert!(
            client.channel_open_session().await.is_err(),
            "a channel beyond the cap must be rejected even when the open ones are SFTP"
        );
    });
}

/// A rejected exec must not free the channel's slot either.
///
/// Non-UTF-8 exec data is the cheapest version of the same bug the SFTP test
/// covers: it needs no container and no successful execution. If
/// `exec_request` gives up the pending slot before validating, a client can
/// spam malformed execs to open unbounded channels past the cap.
#[test]
fn a_rejected_exec_does_not_free_the_channel_slot() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;
        let client = authed_client(&env).await;

        let mut channels = Vec::new();
        for _ in 0..MAX_CHANNELS_PER_CONNECTION {
            let channel = client
                .channel_open_session()
                .await
                .expect("should open up to the cap");
            // Invalid UTF-8 — the server rejects this before starting anything.
            channel
                .exec(true, &[0xff, 0xfe][..])
                .await
                .expect("request is sent even though the server will reject it");
            channels.push(channel);
        }

        assert!(
            client.channel_open_session().await.is_err(),
            "a channel beyond the cap must be rejected even after its exec was refused"
        );
    });
}

#[test]
fn channel_count_over_limit_is_rejected() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;
        let client = authed_client(&env).await;

        let mut opened = Vec::new();
        for _ in 0..MAX_CHANNELS_PER_CONNECTION {
            opened.push(client.channel_open_session().await.unwrap());
        }

        let extra = client.channel_open_session().await;
        assert!(
            extra.is_err(),
            "channel beyond the per-connection limit must be rejected"
        );
    });
}

// ---------------------------------------------------------------------
// 7. TTL-bounded revocation semantics
//
// The guest holds no per-credential state, so revoking a credential in the
// Hosted API cannot and does not affect a running guest. What bounds a
// revoked credential is its own expiry -- which the guest *does* enforce.
// ---------------------------------------------------------------------

#[test]
fn an_already_authenticated_session_survives_certificate_expiry() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;
        let key = test_support::generate_ed25519();
        // Valid now, expires almost immediately.
        let cert = test_support::sign_cert(
            &env.ca,
            &key,
            &test_support::default_principals(),
            SystemTime::now() - Duration::from_secs(30),
            SystemTime::now() + Duration::from_secs(2),
        );
        let client = connect_and_auth(&env, &key, cert).await;

        tokio::time::sleep(Duration::from_secs(3)).await;

        // Established session keeps working: expiry gates authentication, it
        // does not terminate live sessions.
        let mut channel = client.channel_open_session().await.unwrap();
        channel.exec(true, &b"echo still-here"[..]).await.unwrap();
        let (stdout, _, exit) = drain_until_closed(&mut channel).await;
        assert_eq!(String::from_utf8_lossy(&stdout).trim(), "still-here");
        assert_eq!(exit, Some(0));

        // A brand new connection with the same, now-expired certificate is
        // rejected.
        let expired = test_support::sign_cert(
            &env.ca,
            &key,
            &test_support::default_principals(),
            SystemTime::now() - Duration::from_secs(600),
            SystemTime::now() - Duration::from_secs(300),
        );
        let (_new_client, result) = try_connect_and_auth(&env, SSH_LOGIN_USER, &key, expired).await;
        assert!(matches!(result, AuthResult::Failure { .. }));
    });
}

// ---------------------------------------------------------------------
// 8. Listener lifecycle and readiness diagnostics
// ---------------------------------------------------------------------

#[test]
fn a_disabled_config_opens_no_listener_and_reports_nothing() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;
        // `run(.., ssh = None)` is the default path; `spawn` is simply never
        // called, so the status cell stays at its default.
        let status = env.guest.ssh_status.read().unwrap().clone();
        assert!(!status.listener_ready);
        assert!(status.host_fingerprint.is_empty());
        assert!(status.trusted_ca_key_ids.is_empty());
    });
}

#[test]
fn spawn_publishes_readiness_host_fingerprint_and_trusted_ca_key_ids() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;
        let status = env.guest.ssh_status.clone();

        let handle = super::spawn(
            env.guest.clone(),
            "127.0.0.1:0".parse().unwrap(),
            env.trust.clone(),
            status.clone(),
        )
        .await
        .expect("listener should start");

        let published = status.read().unwrap().clone();
        assert!(published.listener_ready);
        assert_eq!(published.host_fingerprint, handle.host_fingerprint);
        assert!(published.host_fingerprint.starts_with("SHA256:"));
        assert_eq!(published.trusted_ca_key_ids, vec!["ca-key-1".to_string()]);
        // Only non-secret material is ever published.
        assert!(published.host_public_key.starts_with("ssh-ed25519 "));
    });
}

#[test]
fn the_host_key_persists_across_listener_restarts() {
    shared_runtime().block_on(async {
        let env = start_test_server().await;

        let first = super::spawn(
            env.guest.clone(),
            "127.0.0.1:0".parse().unwrap(),
            env.trust.clone(),
            env.guest.ssh_status.clone(),
        )
        .await
        .expect("first listener should start");

        // Same guest layout (same rootfs) => same persisted host key, so a
        // client that pinned the fingerprint still recognizes the box.
        let second = super::spawn(
            env.guest.clone(),
            "127.0.0.1:0".parse().unwrap(),
            env.trust.clone(),
            env.guest.ssh_status.clone(),
        )
        .await
        .expect("second listener should start");

        assert_eq!(first.host_fingerprint, second.host_fingerprint);
        assert_ne!(first.bound_addr, second.bound_addr);
    });
}
