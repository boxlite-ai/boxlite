//! `SshConnection`, the per-connection `russh::server::Handler`: channel
//! routing, public-key authentication, and dispatch to the Execution bridge
//! / SFTP adapter.
//!
//! Only `root`, authenticated with a matching active/unexpired public key
//! from the injected [`AccessState`] snapshot, may do anything here. `none`
//! and `password` are unconditionally rejected in production code -- there
//! is no debug bypass, per the design's Phase 1 agent constraints.
//!
//! There is no `russh::server::Server` factory here: `mod.rs`'s
//! `accept_loop` drives `russh::server::run_stream` directly per accepted
//! connection so it can bound concurrency with a semaphore before a
//! `SshConnection` is even constructed, something `Server::new_client`
//! (sync, called after the handshake starts) can't do.

use crate::service::files::backend::GuestFilesystem;
use crate::service::server::GuestServer;
use crate::service::ssh::access::{self, AccessState};
use crate::service::ssh::bridge::{ChannelBridge, Command};
use crate::service::ssh::limits::{MAX_CHANNELS_PER_CONNECTION, MAX_ENV_VALUE_BYTES, MAX_ENV_VARS};
use crate::service::ssh::sftp::SftpSession;
use boxlite_shared::execution_client::ExecutionClient;
use russh::keys::{PrivateKey, PublicKey};
use russh::server::{Auth, ChannelOpenHandle, Handle as SessionHandle, Msg, Session};
use russh::{Channel, ChannelId, Pty};
use std::collections::HashMap;
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
    access: Arc<AccessState>,
    execution_client: ExecutionClient<TonicChannel>,
    pending_channels: HashMap<ChannelId, Channel<Msg>>,
    pending_state: HashMap<ChannelId, PendingChannelState>,
    bridges: HashMap<ChannelId, ChannelBridge>,
    /// Set on successful auth, logged only as a fingerprint -- never the key body.
    authenticated_fingerprint: Option<String>,
}

impl SshConnection {
    pub(crate) fn new(
        guest: Arc<GuestServer>,
        access: Arc<AccessState>,
        execution_client: ExecutionClient<TonicChannel>,
    ) -> Self {
        Self {
            guest,
            access,
            execution_client,
            pending_channels: HashMap::new(),
            pending_state: HashMap::new(),
            bridges: HashMap::new(),
            authenticated_fingerprint: None,
        }
    }

    fn open_channel_count(&self) -> usize {
        self.pending_channels.len() + self.bridges.len()
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
        // Ownership isn't verified yet at this stage; the real decision is
        // in `auth_publickey`, after the signature is checked. Accepting
        // here just lets the client proceed to sign.
        Ok(Auth::Accept)
    }

    async fn auth_publickey(
        &mut self,
        user: &str,
        public_key: &PublicKey,
    ) -> Result<Auth, Self::Error> {
        let matched = self
            .access
            .authenticate(user, public_key, SystemTime::now());
        if matched {
            self.authenticated_fingerprint = Some(access::fingerprint(public_key));
            info!(fingerprint = ?self.authenticated_fingerprint, "ssh: auth accepted");
            Ok(Auth::Accept)
        } else {
            // Never log whether the fingerprint is registered -- that would
            // let an attacker enumerate valid credentials.
            info!(user, "ssh: auth rejected");
            Ok(Auth::reject())
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
        self.pending_channels.remove(&channel);
        let handle = session.handle();
        match self.start_execution(channel, Command::Shell, handle).await {
            Ok(()) => session.channel_success(channel)?,
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
        self.pending_channels.remove(&channel);
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
            Ok(()) => session.channel_success(channel)?,
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
        let Some(raw_channel) = self.pending_channels.remove(&channel) else {
            session.channel_failure(channel)?;
            return Ok(());
        };
        self.pending_state.remove(&channel);

        let container_id =
            match crate::service::files::resolve_container_id(&self.guest.containers, "").await {
                Ok(id) => id,
                Err(e) => {
                    warn!(error = %e, "ssh: sftp start failed to resolve container");
                    session.channel_failure(channel)?;
                    return Ok(());
                }
            };

        session.channel_success(channel)?;
        let filesystem: Arc<GuestFilesystem> = self.guest.filesystem.clone();
        let sftp = SftpSession::new(filesystem, container_id);
        tokio::spawn(async move {
            russh_sftp::server::run(raw_channel.into_stream(), sftp).await;
        });
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
        nodelay: true,
        ..Default::default()
    }
}
