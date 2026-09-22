//! A forwarder opens each transport within a short runtime lifetime. Keeping
//! an SDK TunnelForwarder alive would also keep BOXLITE_HOME locked, preventing
//! setup/status/disable from another CLI while users are logged in.

use anyhow::{Context, Result, anyhow};
use boxlite::BoxConnection;
use tokio::net::TcpListener;
use tokio::task::JoinSet;

use super::{ForwardArgs, connection::Login, guest_address};
use crate::cli::GlobalFlags;

const MAX_CONNECTIONS: usize = 64;
const OPEN_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

pub(super) struct Forwarder {
    listener: TcpListener,
    relays: JoinSet<()>,
}

impl Forwarder {
    pub(super) async fn run(
        args: ForwardArgs,
        global: &GlobalFlags,
        id: String,
        mut login: Login,
    ) -> Result<()> {
        let listener = TcpListener::bind(args.listen)
            .await
            .with_context(|| format!("Bind SSH forward listener {}", args.listen))?;
        login.use_listener(listener.local_addr()?)?;
        args.prepare.format.write(&login, std::io::stdout())?;
        let mut forwarder = Self {
            listener,
            relays: JoinSet::new(),
        };
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        let result = tokio::select! {
            result = forwarder.accept(global, &id) => result,
            signal = tokio::signal::ctrl_c() => signal.context("Wait for Ctrl-C"),
            _ = terminate.recv() => Ok(()),
        };
        forwarder.relays.shutdown().await;
        result
    }

    async fn accept(&mut self, global: &GlobalFlags, id: &str) -> Result<()> {
        loop {
            tokio::select! {
                result = self.relays.join_next(), if !self.relays.is_empty() => {
                    if let Some(Err(error)) = result { tracing::warn!(%error, "SSH relay task failed"); }
                }
                accepted = self.listener.accept(), if self.relays.len() < MAX_CONNECTIONS => {
                    let (mut client, _) = accepted.context("Accept SSH forward connection")?;
                    // Serialize runtime acquisition here. Relays own only streams,
                    // so one slow session cannot retain the runtime directory lock.
                    let connection = tokio::time::timeout(OPEN_TIMEOUT, open_connection(global, id)).await
                        .map_err(|_| anyhow!("Open SSH tunnel timed out after 30 seconds"))
                        .and_then(|result| result);
                    match connection {
                        Ok(mut connection) => {
                            self.relays.spawn(async move {
                                if let Err(error) = tokio::io::copy_bidirectional(&mut client, &mut connection).await {
                                    tracing::warn!(%error, "SSH forward connection failed");
                                }
                            });
                        }
                        Err(error) => tracing::warn!(%error, "Open SSH forward connection failed"),
                    }
                }
            }
        }
    }
}

async fn open_connection(global: &GlobalFlags, id: &str) -> Result<BoxConnection> {
    let runtime = global.create_runtime()?;
    let sandbox = runtime
        .get(id)
        .await?
        .ok_or_else(|| anyhow!("No such box: {id}"))?;
    let connection = sandbox
        .network()
        .tunnel(guest_address()?)
        .await?
        .connect()?;
    Ok(connection)
}
