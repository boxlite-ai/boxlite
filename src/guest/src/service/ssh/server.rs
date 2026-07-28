//! Per-connection russh handler and protocol policy.

use crate::service::server::GuestServer;
use crate::service::ssh::auth::{CertificateAuthorizer, CertificatePermissions, SSH_USER};
use crate::service::ssh::bridge::{signal_number, ChannelBridge, Command};
use crate::service::ssh::forward::ForwardingManager;
use crate::service::ssh::limits::{
    MAX_CHANNELS_PER_CONNECTION, MAX_COMMAND_BYTES, MAX_ENV_NAME_BYTES, MAX_ENV_VALUE_BYTES,
    MAX_ENV_VARS, MAX_TERM_BYTES,
};
use crate::service::ssh::reverse_streamlocal::ReverseStreamlocalManager;
use crate::service::ssh::streamlocal;
use boxlite_shared::{TtyConfig, TtyMode};
use russh::keys::{Algorithm, Certificate, EcdsaCurve, HashAlg, PrivateKey, PublicKey};
use russh::server::{Auth, ChannelOpenHandle, Handle as SessionHandle, Msg, Session};
use russh::{Channel, ChannelId, MethodKind, MethodSet, Pty, Sig};
use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tokio::sync::{oneshot, watch};
use tracing::{info, warn};

#[derive(Default)]
struct PendingChannelState {
    env: HashMap<String, String>,
    tty: Option<TtyConfig>,
    pty_term: Option<String>,
}

impl PendingChannelState {
    fn into_execution_env(mut self) -> HashMap<String, String> {
        if let Some(term) = self.pty_term {
            self.env.insert("TERM".to_string(), term);
        }
        self.env
    }
}

pub(crate) struct SshConnection {
    guest: Arc<GuestServer>,
    authorizer: Arc<CertificateAuthorizer>,
    policy_rx: watch::Receiver<Option<Arc<CertificateAuthorizer>>>,
    pending_channels: HashSet<ChannelId>,
    pending_state: HashMap<ChannelId, PendingChannelState>,
    bridges: HashMap<ChannelId, ChannelBridge>,
    permissions: CertificatePermissions,
    forwarding: ForwardingManager,
    reverse_streamlocal: ReverseStreamlocalManager,
    authenticated: Option<oneshot::Sender<()>>,
}

impl SshConnection {
    pub(crate) fn new(
        guest: Arc<GuestServer>,
        authorizer: Arc<CertificateAuthorizer>,
        policy_rx: watch::Receiver<Option<Arc<CertificateAuthorizer>>>,
        authenticated: oneshot::Sender<()>,
    ) -> Self {
        Self {
            guest,
            authorizer,
            policy_rx,
            pending_channels: HashSet::new(),
            pending_state: HashMap::new(),
            bridges: HashMap::new(),
            permissions: CertificatePermissions::default(),
            forwarding: ForwardingManager::new(),
            reverse_streamlocal: ReverseStreamlocalManager::new(),
            authenticated: Some(authenticated),
        }
    }

    fn open_channel_count(&self) -> usize {
        self.pending_channels.len() + self.bridges.len()
    }

    fn is_shutting_down(&self) -> bool {
        self.guest
            .shutting_down
            .load(std::sync::atomic::Ordering::SeqCst)
    }

    async fn start_execution(
        &mut self,
        channel_id: ChannelId,
        command: Command,
        session_handle: SessionHandle,
    ) -> Result<(), String> {
        if self.is_shutting_down() {
            return Err("guest shutdown has started".into());
        }
        let mut state = self.pending_state.remove(&channel_id).unwrap_or_default();
        let tty = state.tty.take();
        let env = state.into_execution_env();
        let bridge = ChannelBridge::start(
            self.guest.clone(),
            command,
            tty,
            env,
            channel_id,
            session_handle,
        )
        .await
        .map_err(|error| error.to_string())?;
        self.pending_channels.remove(&channel_id);
        self.bridges.insert(channel_id, bridge);
        Ok(())
    }

    fn abandon_pending_channel(&mut self, channel_id: ChannelId) {
        self.pending_channels.remove(&channel_id);
        self.pending_state.remove(&channel_id);
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
        user: &str,
        _public_key: &PublicKey,
    ) -> Result<Auth, Self::Error> {
        // Certificate authentication uses the publickey wire method. The
        // actual decision is made only after russh verifies the signature.
        Ok(if user == SSH_USER {
            Auth::Accept
        } else {
            Auth::reject()
        })
    }

    async fn auth_publickey(
        &mut self,
        _user: &str,
        _public_key: &PublicKey,
    ) -> Result<Auth, Self::Error> {
        // Raw keys are deliberately unsupported; only CA-signed certificates
        // can reach the container.
        Ok(Auth::reject())
    }

    async fn auth_openssh_certificate(
        &mut self,
        user: &str,
        certificate: &Certificate,
    ) -> Result<Auth, Self::Error> {
        let Some(identity) = self.authorizer.authorize(user, certificate) else {
            self.permissions = CertificatePermissions::default();
            info!(user, "SSH certificate rejected");
            return Ok(Auth::reject());
        };

        let Some(policy_guard) =
            super::authentication_policy_guard(&self.policy_rx, &self.authorizer)
        else {
            self.permissions = CertificatePermissions::default();
            info!(
                user,
                "SSH certificate rejected after authentication policy changed"
            );
            return Ok(Auth::reject());
        };

        self.permissions = identity.permissions;
        if let Some(authenticated) = self.authenticated.take() {
            let _ = authenticated.send(());
        }

        // Keep the policy read lock through the authentication signal. A
        // concurrent Configure/Disable publication therefore happens either
        // wholly before this commit (and is rejected above) or wholly after it
        // (and applies only to later authentication attempts).
        drop(policy_guard);
        info!(key_id = certificate.key_id(), "SSH certificate accepted");
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.is_shutting_down() || self.open_channel_count() >= MAX_CHANNELS_PER_CONNECTION {
            warn!(
                open_channels = self.open_channel_count(),
                limit = MAX_CHANNELS_PER_CONNECTION,
                "SSH channel limit reached"
            );
            reply
                .reject(russh::ChannelOpenFailure::ResourceShortage)
                .await;
            return Ok(());
        }

        let channel_id = channel.id();
        self.pending_channels.insert(channel_id);
        self.pending_state
            .insert(channel_id, PendingChannelState::default());
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
        channel: Channel<Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.is_shutting_down() || !self.permissions.port_forwarding {
            reply
                .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        }
        self.forwarding
            .open_direct_tcpip(channel, host_to_connect, port_to_connect, reply)
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
        channel: Channel<Msg>,
        socket_path: &str,
        reply: ChannelOpenHandle,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.is_shutting_down() {
            reply
                .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                .await;
            return Ok(());
        }
        if let Some(reason) = direct_streamlocal_rejection(
            self.permissions.port_forwarding,
            self.open_channel_count(),
            socket_path,
        ) {
            reply.reject(reason).await;
            return Ok(());
        }

        let channel_id = channel.id();
        let session_handle = session.handle();
        match ChannelBridge::start(
            self.guest.clone(),
            Command::Streamlocal(socket_path.to_string()),
            None,
            HashMap::new(),
            channel_id,
            session_handle,
        )
        .await
        {
            Ok(bridge) => {
                // `start` has observed the in-container connect handshake, but
                // its output pump remains gated until confirmation is queued.
                reply.accept().await;
                self.bridges.insert(channel_id, bridge);
                self.bridges
                    .get_mut(&channel_id)
                    .expect("streamlocal bridge was just inserted")
                    .activate_output();
            }
            Err(error) => {
                warn!(%error, "SSH direct streamlocal helper start failed");
                reply.reject(russh::ChannelOpenFailure::ConnectFailed).await;
            }
        }
        Ok(())
    }

    async fn env_request(
        &mut self,
        channel: ChannelId,
        variable_name: &str,
        variable_value: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let Some(state) = self.pending_state.get_mut(&channel) else {
            session.channel_failure(channel)?;
            return Ok(());
        };
        if state.env.len() >= MAX_ENV_VARS
            || !is_valid_env_name(variable_name)
            || variable_value.len() > MAX_ENV_VALUE_BYTES
            || variable_value.contains('\0')
        {
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
        term: &str,
        col_width: u32,
        row_height: u32,
        pix_width: u32,
        pix_height: u32,
        modes: &[(Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if !self.permissions.pty {
            session.channel_failure(channel)?;
            return Ok(());
        }
        let Some(state) = self.pending_state.get_mut(&channel) else {
            session.channel_failure(channel)?;
            return Ok(());
        };
        if !apply_pty_request(
            state,
            term,
            (row_height, col_width, pix_width, pix_height),
            modes,
        ) {
            session.channel_failure(channel)?;
            return Ok(());
        }
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
        let Some(bridge) = self.bridges.get(&channel) else {
            session.channel_failure(channel)?;
            return Ok(());
        };
        match bridge
            .resize(row_height, col_width, pix_width, pix_height)
            .await
        {
            Ok(()) => session.channel_success(channel)?,
            Err(error) => {
                warn!(%error, "SSH resize request failed");
                session.channel_failure(channel)?;
            }
        }
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if !self.pending_channels.contains(&channel) {
            session.channel_failure(channel)?;
            return Ok(());
        }

        match self
            .start_execution(channel, Command::Shell, session.handle())
            .await
        {
            Ok(()) => session.channel_success(channel)?,
            Err(error) => {
                warn!(%error, "SSH shell start failed");
                self.abandon_pending_channel(channel);
                session.channel_failure(channel)?;
                session.close(channel)?;
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
        if !self.pending_channels.contains(&channel) {
            self.abandon_pending_channel(channel);
            session.channel_failure(channel)?;
            return Ok(());
        }
        let Some(command) = valid_exec_command(data).map(str::to_string) else {
            self.abandon_pending_channel(channel);
            session.channel_failure(channel)?;
            session.close(channel)?;
            return Ok(());
        };

        info!(channel = ?channel, command_len = command.len(), "SSH exec request");
        match self
            .start_execution(channel, Command::Exec(command), session.handle())
            .await
        {
            Ok(()) => session.channel_success(channel)?,
            Err(error) => {
                warn!(%error, "SSH exec start failed");
                self.abandon_pending_channel(channel);
                session.channel_failure(channel)?;
                session.close(channel)?;
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
        if name != "sftp" || !self.pending_channels.contains(&channel) {
            let was_pending = self.pending_channels.contains(&channel);
            self.abandon_pending_channel(channel);
            session.channel_failure(channel)?;
            if was_pending {
                session.close(channel)?;
            }
            return Ok(());
        }

        match self
            .start_execution(channel, Command::Sftp, session.handle())
            .await
        {
            Ok(()) => session.channel_success(channel)?,
            Err(error) => {
                warn!(%error, "SSH SFTP subsystem start failed");
                self.abandon_pending_channel(channel);
                session.channel_failure(channel)?;
                session.close(channel)?;
            }
        }
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

    async fn signal(
        &mut self,
        channel: ChannelId,
        signal: Sig,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        let Some(signal) = signal_number(&signal) else {
            warn!(channel = ?channel, "SSH client requested an unsupported signal");
            return Ok(());
        };
        let Some(bridge) = self.bridges.get(&channel) else {
            return Ok(());
        };
        if let Err(error) = bridge.signal(signal).await {
            warn!(%error, channel = ?channel, signal, "SSH signal forwarding failed");
        }
        Ok(())
    }

    async fn tcpip_forward(
        &mut self,
        address: &str,
        port: &mut u32,
        session: &mut Session,
    ) -> Result<bool, Self::Error> {
        if self.is_shutting_down() || !self.permissions.port_forwarding {
            return Ok(false);
        }
        Ok(self
            .forwarding
            .listen_tcpip(address, port, session.handle())
            .await)
    }

    async fn cancel_tcpip_forward(
        &mut self,
        address: &str,
        port: u32,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        if !self.permissions.port_forwarding {
            return Ok(false);
        }
        Ok(self.forwarding.cancel_tcpip(address, port).await)
    }

    async fn streamlocal_forward(
        &mut self,
        socket_path: &str,
        session: &mut Session,
    ) -> Result<bool, Self::Error> {
        if self.is_shutting_down()
            || !reverse_streamlocal_allowed(self.permissions.port_forwarding, socket_path)
        {
            return Ok(false);
        }
        Ok(self
            .reverse_streamlocal
            .listen(socket_path, self.guest.clone(), session.handle())
            .await)
    }

    async fn cancel_streamlocal_forward(
        &mut self,
        socket_path: &str,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        if !reverse_streamlocal_allowed(self.permissions.port_forwarding, socket_path) {
            return Ok(false);
        }
        Ok(self.reverse_streamlocal.cancel(socket_path).await)
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
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let send_result = match self.bridges.get(&channel) {
            Some(bridge) => bridge.stdin(data.to_vec()).await,
            None => return Ok(()),
        };
        if let Err(error) = send_result {
            warn!(%error, "SSH stdin forwarding failed");
            if let Some(mut bridge) = self.bridges.remove(&channel) {
                bridge.terminate_running();
            }
            session.close(channel)?;
        }
        Ok(())
    }

    async fn channel_eof(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let send_result = match self.bridges.get(&channel) {
            Some(bridge) => bridge.stdin_eof().await,
            None => return Ok(()),
        };
        if let Err(error) = send_result {
            warn!(%error, "SSH stdin EOF forwarding failed");
            if let Some(mut bridge) = self.bridges.remove(&channel) {
                bridge.terminate_running();
            }
            session.close(channel)?;
        }
        Ok(())
    }

    async fn channel_close(
        &mut self,
        channel: ChannelId,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.abandon_pending_channel(channel);
        if let Some(mut bridge) = self.bridges.remove(&channel) {
            bridge.terminate_running();
        }
        Ok(())
    }
}

impl Drop for SshConnection {
    fn drop(&mut self) {
        for (_, mut bridge) in self.bridges.drain() {
            bridge.terminate_running();
        }
    }
}

fn is_valid_env_name(name: &str) -> bool {
    if name.is_empty() || name.len() > MAX_ENV_NAME_BYTES {
        return false;
    }
    let mut bytes = name.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn valid_exec_command(data: &[u8]) -> Option<&str> {
    if data.len() > MAX_COMMAND_BYTES || data.contains(&0) {
        return None;
    }
    std::str::from_utf8(data).ok()
}

fn direct_streamlocal_rejection(
    can_forward: bool,
    open_channels: usize,
    socket_path: &str,
) -> Option<russh::ChannelOpenFailure> {
    if !can_forward || !streamlocal::is_valid_target(socket_path) {
        Some(russh::ChannelOpenFailure::AdministrativelyProhibited)
    } else if open_channels >= MAX_CHANNELS_PER_CONNECTION {
        Some(russh::ChannelOpenFailure::ResourceShortage)
    } else {
        None
    }
}

fn reverse_streamlocal_allowed(can_forward: bool, socket_path: &str) -> bool {
    can_forward && streamlocal::is_valid_target(socket_path)
}

fn apply_pty_request(
    state: &mut PendingChannelState,
    term: &str,
    dimensions: (u32, u32, u32, u32),
    modes: &[(Pty, u32)],
) -> bool {
    if term.is_empty()
        || term.len() > MAX_TERM_BYTES
        || !term.bytes().all(|byte| byte.is_ascii_graphic())
        || (state.env.len() >= MAX_ENV_VARS && !state.env.contains_key("TERM"))
    {
        return false;
    }

    let (rows, cols, x_pixels, y_pixels) = dimensions;
    let tty = TtyConfig {
        rows,
        cols,
        x_pixels,
        y_pixels,
        modes: modes
            .iter()
            .map(|(opcode, value)| TtyMode {
                opcode: *opcode as u32,
                value: *value,
            })
            .collect(),
    };
    if crate::service::exec::exec_handle::PtyConfig::try_from(&tty).is_err() {
        return false;
    }

    // OpenSSH carries the terminal type in the PTY request, not necessarily
    // in a separate environment request. The PTY value is authoritative.
    state.env.insert("TERM".to_string(), term.to_string());
    state.pty_term = Some(term.to_string());
    state.tty = Some(tty);
    true
}

pub(crate) fn build_config(host_key: PrivateKey) -> russh::server::Config {
    let mut methods = MethodSet::empty();
    methods.push(MethodKind::PublicKey);
    let preferred = russh::Preferred {
        key: Cow::Owned(vec![
            Algorithm::Ed25519,
            Algorithm::SkEd25519,
            Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP256,
            },
            Algorithm::SkEcdsaSha2NistP256,
            Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP384,
            },
            Algorithm::Ecdsa {
                curve: EcdsaCurve::NistP521,
            },
            Algorithm::Rsa {
                hash: Some(HashAlg::Sha512),
            },
            Algorithm::Rsa {
                hash: Some(HashAlg::Sha256),
            },
        ]),
        // Immediate zlib exposes the decompressor before authentication.
        // OpenSSH's delayed variant activates only after auth succeeds.
        compression: Cow::Owned(vec![
            russh::compression::NONE,
            russh::compression::ZLIB_LEGACY,
        ]),
        ..Default::default()
    };

    russh::server::Config {
        methods,
        preferred,
        auth_rejection_time: std::time::Duration::from_millis(500),
        auth_rejection_time_initial: Some(std::time::Duration::ZERO),
        keys: vec![host_key],
        max_auth_attempts: 6,
        keepalive_interval: Some(std::time::Duration::from_secs(30)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::GuestLayout;
    use russh::keys::ssh_key::certificate::{Builder, CertType};
    use russh::keys::{Algorithm, PrivateKey};
    use russh::server::Handler as _;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn user_certificate(ca_key: &PrivateKey, principal: &str) -> Certificate {
        let mut rng = russh::keys::key::safe_rng();
        let subject_key = PrivateKey::random(&mut rng, Algorithm::Ed25519).unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let mut builder = Builder::new_with_random_nonce(
            &mut rng,
            subject_key.public_key(),
            now.saturating_sub(60),
            now.saturating_add(60),
        )
        .unwrap();
        builder.cert_type(CertType::User).unwrap();
        builder.key_id("boxlite-server-test").unwrap();
        builder.valid_principal(principal).unwrap();
        builder.extension("permit-pty", "").unwrap();
        builder.sign(ca_key).unwrap()
    }

    async fn test_connection(
        authorizer: Arc<CertificateAuthorizer>,
        policy_rx: watch::Receiver<Option<Arc<CertificateAuthorizer>>>,
    ) -> (SshConnection, oneshot::Receiver<()>) {
        let guest = Arc::new(GuestServer::new(GuestLayout::new()));
        let (authenticated_tx, authenticated_rx) = oneshot::channel();
        (
            SshConnection::new(guest, authorizer, policy_rx, authenticated_tx),
            authenticated_rx,
        )
    }

    #[tokio::test]
    async fn certificate_authentication_commits_only_the_current_policy_epoch() {
        let ca_key = {
            let mut rng = russh::keys::key::safe_rng();
            PrivateKey::random(&mut rng, Algorithm::Ed25519).unwrap()
        };
        let ca_public_key = ca_key.public_key().to_openssh().unwrap();
        let certificate = user_certificate(&ca_key, "box_123");
        let accepted = Arc::new(CertificateAuthorizer::new(&ca_public_key, "box_123").unwrap());

        let (_policy_tx, policy_rx) = watch::channel(Some(accepted.clone()));
        let (mut current, mut committed) = test_connection(accepted.clone(), policy_rx).await;
        let auth = current
            .auth_openssh_certificate(SSH_USER, &certificate)
            .await
            .unwrap();

        assert_eq!(auth, Auth::Accept);
        assert!(current.permissions.pty);
        assert!(matches!(committed.try_recv(), Ok(())));

        let (policy_tx, policy_rx) = watch::channel(Some(accepted.clone()));
        let (mut stale, mut not_committed) = test_connection(accepted.clone(), policy_rx).await;
        policy_tx.send_replace(Some(Arc::new(
            CertificateAuthorizer::new(&ca_public_key, "box_456").unwrap(),
        )));
        policy_tx.send_replace(Some(accepted));

        let auth = stale
            .auth_openssh_certificate(SSH_USER, &certificate)
            .await
            .unwrap();

        assert_eq!(auth, Auth::reject());
        assert_eq!(stale.permissions, CertificatePermissions::default());
        assert!(matches!(
            not_committed.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
    }

    #[test]
    fn accepts_only_bounded_portable_environment_names() {
        for name in ["TERM", "LC_ALL", "_BOX_1"] {
            assert!(is_valid_env_name(name));
        }
        for name in ["", "1PATH", "A=B", "A-B", "A\0B"] {
            assert!(!is_valid_env_name(name));
        }
        assert!(!is_valid_env_name(&"A".repeat(MAX_ENV_NAME_BYTES + 1)));
    }

    #[test]
    fn exec_command_must_be_bounded_utf8_without_nul() {
        assert_eq!(
            valid_exec_command(b"printf '%s' hello"),
            Some("printf '%s' hello")
        );
        assert_eq!(valid_exec_command(b""), Some(""));
        assert!(valid_exec_command(b"printf before\0after").is_none());
        assert!(valid_exec_command(&[0xff]).is_none());
        assert!(valid_exec_command(&vec![b'x'; MAX_COMMAND_BYTES + 1]).is_none());
    }

    #[test]
    fn direct_streamlocal_requires_certificate_permission_path_and_capacity() {
        assert_eq!(
            direct_streamlocal_rejection(false, 0, "/run/service.sock"),
            Some(russh::ChannelOpenFailure::AdministrativelyProhibited)
        );
        assert_eq!(
            direct_streamlocal_rejection(true, 0, "relative.sock"),
            Some(russh::ChannelOpenFailure::AdministrativelyProhibited)
        );
        assert_eq!(
            direct_streamlocal_rejection(true, MAX_CHANNELS_PER_CONNECTION, "/run/service.sock"),
            Some(russh::ChannelOpenFailure::ResourceShortage)
        );
        assert_eq!(
            direct_streamlocal_rejection(true, 0, "/run/service.sock"),
            None
        );
    }

    #[test]
    fn reverse_streamlocal_requires_certificate_permission_and_safe_path() {
        assert!(!reverse_streamlocal_allowed(false, "/run/service.sock"));
        assert!(!reverse_streamlocal_allowed(true, "relative.sock"));
        assert!(reverse_streamlocal_allowed(true, "/run/service.sock"));
    }

    #[test]
    fn advertises_only_public_key_authentication() {
        let mut rng = russh::keys::key::safe_rng();
        let host_key = PrivateKey::random(&mut rng, Algorithm::Ed25519).unwrap();
        let config = build_config(host_key);

        assert_eq!(&*config.methods, &[MethodKind::PublicKey]);
        assert_eq!(config.max_auth_attempts, 6);
        assert!(config.preferred.key.contains(&Algorithm::Ed25519));
        assert!(config.preferred.key.contains(&Algorithm::SkEd25519));
        assert!(config.preferred.key.contains(&Algorithm::Rsa {
            hash: Some(HashAlg::Sha512),
        }));
        assert!(config.preferred.key.contains(&Algorithm::Rsa {
            hash: Some(HashAlg::Sha256),
        }));
        assert!(!config
            .preferred
            .key
            .contains(&Algorithm::Rsa { hash: None }));
        assert!(!config.preferred.key.contains(&Algorithm::Dsa));
        assert!(config
            .preferred
            .compression
            .contains(&russh::compression::ZLIB_LEGACY));
        assert!(!config
            .preferred
            .compression
            .contains(&russh::compression::ZLIB));
    }

    #[test]
    fn pty_request_sets_a_bounded_authoritative_term() {
        let mut state = PendingChannelState::default();
        state.env.insert("TERM".into(), "caller-value".into());
        let tty = (24, 80, 0, 0);
        let modes = [(Pty::VINTR, 3), (Pty::ECHO, 0)];

        assert!(apply_pty_request(&mut state, "xterm-256color", tty, &modes));
        assert_eq!(
            state.env.get("TERM").map(String::as_str),
            Some("xterm-256color")
        );
        let requested_tty = state.tty.as_ref().unwrap();
        assert_eq!((requested_tty.rows, requested_tty.cols), (tty.0, tty.1));
        assert_eq!(requested_tty.modes[0].opcode, Pty::VINTR as u32);
        assert_eq!(requested_tty.modes[0].value, 3);

        state.env.insert("TERM".into(), "later-env-value".into());
        assert_eq!(
            state.into_execution_env().get("TERM").map(String::as_str),
            Some("xterm-256color")
        );

        let mut state = PendingChannelState::default();
        for invalid in ["", "xterm\nunsafe"] {
            assert!(!apply_pty_request(&mut state, invalid, tty, &modes));
        }
        assert!(!apply_pty_request(
            &mut state,
            &"x".repeat(MAX_TERM_BYTES + 1),
            tty,
            &modes
        ));
        assert!(!apply_pty_request(
            &mut state,
            "xterm",
            (u16::MAX as u32 + 1, 80, 0, 0),
            &modes
        ));
    }
}
