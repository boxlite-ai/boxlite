//! `SshConnection`, the per-connection `russh::server::Handler`: channel
//! routing, OpenSSH certificate authentication, and dispatch to the Execution
//! bridge / SFTP adapter.
//!
//! The only accepted credential is a short-lived OpenSSH *user certificate*
//! signed by a CA in this VM generation's immutable trust bundle, naming
//! exactly this organization, this box and `root`. `none`, `password` and raw
//! public keys are unconditionally rejected -- there is no debug bypass, per
//! the design's Phase 1 agent constraints.
//!
//! There is no `russh::server::Server` factory here: `mod.rs`'s
//! `accept_loop` drives `russh::server::run_stream` directly per accepted
//! connection so it can bound concurrency with a semaphore before a
//! `SshConnection` is even constructed, something `Server::new_client`
//! (sync, called after the handshake starts) can't do.

use crate::service::files::backend::GuestFilesystem;
use crate::service::server::GuestServer;
use crate::service::ssh::bridge::{ChannelBridge, Command};
use crate::service::ssh::ca::SshTrust;
use crate::service::ssh::limits::{
    CONNECTION_IDLE_TIMEOUT, MAX_CHANNELS_PER_CONNECTION, MAX_ENV_VALUE_BYTES, MAX_ENV_VARS,
};
use crate::service::ssh::sftp::SftpSession;
use boxlite_shared::execution_client::ExecutionClient;
use russh::keys::ssh_key::Certificate;
use russh::keys::{PrivateKey, PublicKey};
use russh::server::{Auth, ChannelOpenHandle, Handle as SessionHandle, Msg, Session};
use russh::{Channel, ChannelId, Pty};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::SystemTime;
use tonic::transport::Channel as TonicChannel;
use tracing::{info, warn};

/// Per-channel state accumulated before a shell/exec actually starts:
/// `env` requests and a `pty` request may arrive in either order, but both
/// must be applied to the `ExecRequest` built when `shell`/`exec` fires.
#[derive(Default)]
struct PendingChannelState {
    env: HashMap<String, String>,
    pty: Option<(u32, u32, u32, u32)>,
}

pub(crate) struct SshConnection {
    guest: Arc<GuestServer>,
    trust: Arc<SshTrust>,
    execution_client: ExecutionClient<TonicChannel>,
    pending_channels: HashMap<ChannelId, Channel<Msg>>,
    pending_state: HashMap<ChannelId, PendingChannelState>,
    bridges: HashMap<ChannelId, ChannelBridge>,
    /// Running SFTP subsystems, one per channel. Tracked rather than detached
    /// so they count against the per-connection channel cap and can be aborted
    /// when the channel or the connection goes away.
    sftp_tasks: HashMap<ChannelId, tokio::task::JoinHandle<()>>,
    /// Set on successful auth, logged only as a fingerprint -- never the key body.
    authenticated_fingerprint: Option<String>,
    /// Shared with `mod.rs`'s connection driver so the authentication deadline
    /// can tell an unauthenticated squatter from a live session.
    authenticated: Arc<AtomicBool>,
}

impl SshConnection {
    pub(crate) fn new(
        guest: Arc<GuestServer>,
        trust: Arc<SshTrust>,
        execution_client: ExecutionClient<TonicChannel>,
    ) -> Self {
        Self {
            guest,
            trust,
            execution_client,
            pending_channels: HashMap::new(),
            pending_state: HashMap::new(),
            bridges: HashMap::new(),
            sftp_tasks: HashMap::new(),
            authenticated_fingerprint: None,
            authenticated: Arc::new(AtomicBool::new(false)),
        }
    }

    pub(crate) fn authenticated_flag(&self) -> Arc<AtomicBool> {
        self.authenticated.clone()
    }

    /// Channels this connection is holding open, in any state.
    ///
    /// SFTP subsystems must be counted here: `subsystem_request` moves a
    /// channel out of `pending_channels`, so without this term a client could
    /// open a channel, start SFTP on it to free the slot, and repeat — running
    /// unbounded concurrent SFTP sessions despite the cap.
    fn open_channel_count(&self) -> usize {
        self.pending_channels.len() + self.bridges.len() + self.sftp_tasks.len()
    }

    async fn start_execution(
        &mut self,
        channel_id: ChannelId,
        command: Command,
        session_handle: SessionHandle,
    ) -> Result<(), String> {
        let state = self.pending_state.remove(&channel_id).unwrap_or_default();
        let bridge = ChannelBridge::start(
            self.execution_client.clone(),
            &self.guest,
            command,
            state.pty,
            state.env,
            channel_id,
            session_handle,
        )
        .await
        .map_err(|e| e.to_string())?;
        self.bridges.insert(channel_id, bridge);
        Ok(())
    }
}

impl russh::server::Handler for SshConnection {
    type Error = russh::Error;

    async fn auth_none(&mut self, _user: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::reject())
    }

    async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::reject())
    }

    async fn auth_publickey_offered(
        &mut self,
        _user: &str,
        _public_key: &PublicKey,
    ) -> Result<Auth, Self::Error> {
        // A probe, not a decision: russh hands us the *inner* key of a
        // certificate here, indistinguishable from a raw key, and no signature
        // has been checked yet. Accepting only lets the client proceed to
        // sign; `auth_publickey` / `auth_openssh_certificate` decide.
        Ok(Auth::Accept)
    }

    async fn auth_publickey(
        &mut self,
        user: &str,
        _public_key: &PublicKey,
    ) -> Result<Auth, Self::Error> {
        // A raw public key is not a credential in this design: authority comes
        // only from a CA signature over a box-bound certificate. The guest
        // holds no per-credential state to check a bare key against.
        info!(user, reason = "raw_public_key", "ssh: auth rejected");
        Ok(Auth::reject())
    }

    async fn auth_openssh_certificate(
        &mut self,
        user: &str,
        certificate: &Certificate,
    ) -> Result<Auth, Self::Error> {
        match self
            .trust
            .verify_user_certificate(user, certificate, SystemTime::now())
        {
            Ok(identity) => {
                self.authenticated_fingerprint = Some(identity.fingerprint.clone());
                self.authenticated.store(true, Ordering::Relaxed);
                info!(
                    fingerprint = %identity.fingerprint,
                    ca_key_id = %identity.ca_key_id,
                    serial = identity.serial,
                    "ssh: auth accepted"
                );
                Ok(Auth::Accept)
            }
            Err(reason) => {
                // Only the stable reason label is logged. Nothing derived from
                // the presented certificate is echoed, so a rejected peer
                // learns nothing about which credentials would be valid.
                info!(user, reason = reason.as_str(), "ssh: auth rejected");
                Ok(Auth::reject())
            }
        }
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.open_channel_count() >= MAX_CHANNELS_PER_CONNECTION {
            warn!(
                open = self.open_channel_count(),
                limit = MAX_CHANNELS_PER_CONNECTION,
                "ssh: channel limit reached, rejecting channel open"
            );
            reply
                .reject(russh::ChannelOpenFailure::ResourceShortage)
                .await;
            return Ok(());
        }
        let id = channel.id();
        self.pending_channels.insert(id, channel);
        self.pending_state
            .insert(id, PendingChannelState::default());
        reply.accept().await;
        Ok(())
    }

    async fn channel_open_x11(
        &mut self,
        _channel: Channel<Msg>,
        _originator_address: &str,
        _originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply
            .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
            .await;
        Ok(())
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        _channel: Channel<Msg>,
        _host_to_connect: &str,
        _port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply
            .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
            .await;
        Ok(())
    }

    async fn channel_open_forwarded_tcpip(
        &mut self,
        _channel: Channel<Msg>,
        _host_to_connect: &str,
        _port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply
            .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
            .await;
        Ok(())
    }

    async fn channel_open_direct_streamlocal(
        &mut self,
        _channel: Channel<Msg>,
        _socket_path: &str,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply
            .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
            .await;
        Ok(())
    }

    async fn env_request(
        &mut self,
        channel: ChannelId,
        variable_name: &str,
        variable_value: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let state = self.pending_state.entry(channel).or_default();
        let oversized =
            variable_name.len() > MAX_ENV_VALUE_BYTES || variable_value.len() > MAX_ENV_VALUE_BYTES;
        if oversized || state.env.len() >= MAX_ENV_VARS {
            session.channel_failure(channel)?;
            return Ok(());
        }
        state
            .env
            .insert(variable_name.to_string(), variable_value.to_string());
        session.channel_success(channel)?;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        col_width: u32,
        row_height: u32,
        pix_width: u32,
        pix_height: u32,
        _modes: &[(Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let state = self.pending_state.entry(channel).or_default();
        state.pty = Some((row_height, col_width, pix_width, pix_height));
        session.channel_success(channel)?;
        Ok(())
    }

    async fn window_change_request(
        &mut self,
        channel: ChannelId,
        col_width: u32,
        row_height: u32,
        pix_width: u32,
        pix_height: u32,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(bridge) = self.bridges.get(&channel) {
            bridge
                .resize(row_height, col_width, pix_width, pix_height)
                .await;
            session.channel_success(channel)?;
        } else {
            session.channel_failure(channel)?;
        }
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        // Give up the pending slot only once a bridge owns the channel. On
        // failure the client still holds it, so it must keep counting against
        // the per-connection cap (see `open_channel_count`).
        let handle = session.handle();
        match self.start_execution(channel, Command::Shell, handle).await {
            Ok(()) => {
                self.pending_channels.remove(&channel);
                session.channel_success(channel)?
            }
            Err(e) => {
                warn!(error = %e, "ssh: shell start failed");
                session.channel_failure(channel)?;
            }
        }
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        // Validate before giving up the pending slot: a rejected exec leaves the
        // channel with the client, so it must keep counting against the cap.
        // Removing first let a client spam malformed exec requests to free
        // slots and open unbounded channels.
        let command = match std::str::from_utf8(data) {
            Ok(s) => s.to_string(),
            Err(_) => {
                session.channel_failure(channel)?;
                return Ok(());
            }
        };
        let handle = session.handle();
        // The command line itself is never logged -- only its length.
        info!(channel = ?channel, command_len = command.len(), "ssh: exec request");
        match self
            .start_execution(channel, Command::Exec(command), handle)
            .await
        {
            Ok(()) => {
                self.pending_channels.remove(&channel);
                session.channel_success(channel)?
            }
            Err(e) => {
                warn!(error = %e, "ssh: exec start failed");
                session.channel_failure(channel)?;
            }
        }
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if name != "sftp" {
            session.channel_failure(channel)?;
            return Ok(());
        }

        // Resolve before taking the channel out of `pending_channels`. Every
        // early return below would otherwise drop the channel from the maps
        // that `open_channel_count` sums, freeing its slot while the client
        // still holds it — so a client could retry a failing subsystem in a
        // loop and open unbounded channels past the cap.
        let container_id =
            match crate::service::files::resolve_container_id(&self.guest.containers, "").await {
                Ok(id) => id,
                Err(e) => {
                    warn!(error = %e, "ssh: sftp start failed to resolve container");
                    session.channel_failure(channel)?;
                    return Ok(());
                }
            };

        let Some(raw_channel) = self.pending_channels.remove(&channel) else {
            session.channel_failure(channel)?;
            return Ok(());
        };
        self.pending_state.remove(&channel);

        session.channel_success(channel)?;
        let filesystem: Arc<GuestFilesystem> = self.guest.filesystem.clone();
        let sftp = SftpSession::new(filesystem, container_id);
        let task = tokio::spawn(async move {
            russh_sftp::server::run(raw_channel.into_stream(), sftp).await;
        });
        self.sftp_tasks.insert(channel, task);
        Ok(())
    }

    async fn agent_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<bool, Self::Error> {
        session.channel_failure(channel)?;
        Ok(false)
    }

    async fn x11_request(
        &mut self,
        channel: ChannelId,
        _single_connection: bool,
        _x11_auth_protocol: &str,
        _x11_auth_cookie: &str,
        _x11_screen_number: u32,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_failure(channel)?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(bridge) = self.bridges.get(&channel) {
            bridge.stdin(data.to_vec());
        }
        Ok(())
    }

    async fn channel_eof(
        &mut self,
        channel: ChannelId,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(bridge) = self.bridges.get(&channel) {
            bridge.stdin_eof();
        }
        Ok(())
    }

    async fn channel_close(
        &mut self,
        channel: ChannelId,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.pending_channels.remove(&channel);
        self.pending_state.remove(&channel);
        if let Some(mut bridge) = self.bridges.remove(&channel) {
            bridge.kill_running();
        }
        if let Some(task) = self.sftp_tasks.remove(&channel) {
            task.abort();
        }
        Ok(())
    }
}

impl Drop for SshConnection {
    /// Best-effort kill for every still-running execution when the
    /// connection itself drops without a clean `channel_close` per channel
    /// (e.g. the underlying tunnel dies mid-session).
    fn drop(&mut self) {
        for (_, mut bridge) in self.bridges.drain() {
            bridge.kill_running();
        }
        // SFTP tasks own the channel stream and file handles; without this they
        // outlive the connection that authorized them.
        for (_, task) in self.sftp_tasks.drain() {
            task.abort();
        }
    }
}

/// Build the `russh::server::Config` for `host_key`, matching the design's
/// error/backoff/auth-attempt bounds.
pub(crate) fn build_config(host_key: PrivateKey) -> russh::server::Config {
    russh::server::Config {
        auth_rejection_time: std::time::Duration::from_millis(500),
        auth_rejection_time_initial: Some(std::time::Duration::from_millis(0)),
        keys: vec![host_key],
        max_auth_attempts: 6,
        // Closes abandoned connections. Any received data resets it, so a
        // quiet-but-live interactive session is not interrupted; only a peer
        // that has genuinely gone away is collected.
        inactivity_timeout: Some(CONNECTION_IDLE_TIMEOUT),
        nodelay: true,
        ..Default::default()
    }
}
