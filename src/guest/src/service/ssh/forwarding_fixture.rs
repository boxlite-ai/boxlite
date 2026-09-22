//! Real SSH transport with explicit control over forwarded-channel confirmation.

use super::{server::SshConnection, GuestServer, SshConfig, TaskGroup};
use russh::keys::{PrivateKey, PrivateKeyWithHashAlg, PublicKey};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{mpsc, oneshot};

pub(super) async fn completes<F: std::future::Future>(future: F) -> F::Output {
    tokio::time::timeout(Duration::from_secs(5), future)
        .await
        .expect("forwarding operation timed out")
}

pub(super) struct OpenChannel {
    pub channel: russh::Channel<russh::client::Msg>,
    pub reply: russh::client::ChannelOpenHandle,
    pub address: String,
}

struct Client {
    host_key: PublicKey,
    channels: mpsc::Sender<OpenChannel>,
}

impl russh::client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        Ok(key == &self.host_key)
    }

    async fn server_channel_open_forwarded_streamlocal(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        socket_path: &str,
        reply: russh::client::ChannelOpenHandle,
        _: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        self.channels
            .send(OpenChannel {
                channel,
                reply,
                address: socket_path.into(),
            })
            .await
            .unwrap();
        Ok(())
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<russh::client::Msg>,
        connected_address: &str,
        _: u32,
        _: &str,
        _: u32,
        reply: russh::client::ChannelOpenHandle,
        _: &mut russh::client::Session,
    ) -> Result<(), Self::Error> {
        self.channels
            .send(OpenChannel {
                channel,
                reply,
                address: connected_address.into(),
            })
            .await
            .unwrap();
        Ok(())
    }
}

pub(super) struct ForwardingSession {
    pub handle: russh::server::Handle,
    pub channels: mpsc::Receiver<OpenChannel>,
    client: russh::client::Handle<Client>,
    server: russh::server::RunningSession<SshConnection>,
}

impl ForwardingSession {
    pub async fn new(guest: Arc<GuestServer>, tasks: Arc<TaskGroup>) -> Self {
        completes(async {
            let key = PrivateKey::random(
                &mut russh::keys::key::safe_rng(),
                russh::keys::Algorithm::Ed25519,
            )
            .unwrap();
            let config = SshConfig::parse(boxlite_shared::SshConfig {
                listen_address: "127.0.0.1:0".into(),
                host_private_key: key.to_openssh(Default::default()).unwrap().to_string(),
                accounts: vec![boxlite_shared::SshAccount {
                    login: "root".into(),
                    authorized_keys: vec![key.public_key().to_openssh().unwrap()],
                    ca: None,
                }],
            })
            .unwrap();
            let (authenticated, ready) = oneshot::channel();
            let handler = SshConnection::new(guest, config.authorizer, authenticated, tasks);
            let (server_stream, client_stream) = tokio::io::duplex(65536);
            let (channels, receiver) = mpsc::channel(4);
            let (server, client) = tokio::join!(
                russh::server::run_stream(config.server, server_stream, handler),
                russh::client::connect_stream(
                    Arc::new(russh::client::Config::default()),
                    client_stream,
                    Client {
                        host_key: key.public_key().clone(),
                        channels
                    }
                ),
            );
            let server = server.unwrap();
            let mut client = client.unwrap();
            assert!(client
                .authenticate_publickey("root", PrivateKeyWithHashAlg::new(Arc::new(key), None))
                .await
                .unwrap()
                .success());
            ready.await.unwrap();
            Self {
                handle: server.handle(),
                channels: receiver,
                client,
                server,
            }
        })
        .await
    }

    pub async fn close(self) {
        completes(async {
            self.client
                .disconnect(russh::Disconnect::ByApplication, "test complete", "")
                .await
                .unwrap();
            assert!(matches!(
                self.server.await,
                Ok(()) | Err(russh::Error::Disconnect)
            ));
            assert!(matches!(
                self.client.await,
                Ok(()) | Err(russh::Error::Disconnect)
            ));
        })
        .await;
    }
}
