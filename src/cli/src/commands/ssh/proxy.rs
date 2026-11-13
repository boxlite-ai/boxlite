//! One stdio connection for OpenSSH ProxyCommand; no listener or authentication changes.

use std::io::{Read, Write};

use anyhow::{Context, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::{mpsc, oneshot};

use crate::cli::GlobalFlags;

/// Relay a single existing SSH listener without configuring or enabling it.
///
/// Installed aliases may pin the backend/endpoint; termination cancels the relay
/// so blocked parent stdio cannot retain the runtime home lock.
pub(super) async fn execute(args: &super::SshArgs, global: &GlobalFlags) -> Result<()> {
    let mut hangup = signal(SignalKind::hangup())?;
    let mut terminate = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    tokio::select! {
        result = async {
            let (_runtime, sandbox) = if args.proxy_local {
                let runtime = global.create_runtime_with_options(global.resolve_runtime_options()?)?;
                let sandbox = runtime.get(&args.target).await?.context("No such box")?;
                (runtime, sandbox)
            } else if let Some(endpoint) = &args.proxy_endpoint {
                let mut pinned = global.clone();
                pinned.url = Some(endpoint.clone());
                super::find_box(&pinned, &args.target).await?
            } else {
                super::find_box(global, &args.target).await?
            };
            let status = sandbox.ssh().status().await?;
            let connection = super::ssh_tunnel(&sandbox, &status).await?.connect().await?;
            let (reader, writer) = connection.into_split();
            relay(reader, writer, || std::io::stdin().lock(), || std::io::stdout().lock()).await
        } => result,
        _ = hangup.recv() => Ok(()),
        _ = terminate.recv() => Ok(()),
        _ = interrupt.recv() => Ok(()),
    }
}

/// Relay bytes with bounded buffering; stdin EOF half-closes only the upload.
async fn relay<R: Read, W: Write>(
    mut reader: impl AsyncRead + Unpin,
    mut writer: impl AsyncWrite + Unpin,
    stdin: impl FnOnce() -> R + Send + 'static,
    stdout: impl FnOnce() -> W + Send + 'static,
) -> Result<()> {
    // Neither stdio thread belongs to Tokio's blocking pool: a pipe held open
    // or full by the parent must not prevent runtime cleanup on cancellation.
    let (input, mut incoming) = mpsc::channel(2);
    std::thread::spawn(move || {
        let mut stdin = stdin();
        loop {
            let mut bytes = vec![0; 8192];
            let result = stdin.read(&mut bytes).map(|n| {
                bytes.truncate(n);
                bytes
            });
            let done = result.as_ref().map_or(true, Vec::is_empty);
            if input.blocking_send(result).is_err() || done {
                break;
            }
        }
    });
    let (output, mut outgoing) =
        mpsc::channel::<(Vec<u8>, oneshot::Sender<std::io::Result<()>>)>(1);
    std::thread::spawn(move || {
        let mut stdout = stdout();
        while let Some((bytes, done)) = outgoing.blocking_recv() {
            let result = stdout.write_all(&bytes).and_then(|()| stdout.flush());
            let failed = result.is_err();
            let _ = done.send(result);
            if failed {
                break;
            }
        }
    });
    let upload = async {
        while let Some(bytes) = incoming.recv().await {
            let bytes = bytes.context("read SSH proxy stdin")?;
            if bytes.is_empty() {
                break;
            }
            writer.write_all(&bytes).await.context("write SSH tunnel")?;
        }
        writer.shutdown().await?;
        Ok::<_, anyhow::Error>(())
    };
    let download = async {
        let mut buffer = [0; 8192];
        loop {
            let count = reader.read(&mut buffer).await.context("read SSH tunnel")?;
            if count == 0 {
                return Ok::<_, anyhow::Error>(());
            }
            let (done, ack) = oneshot::channel();
            output
                .send((buffer[..count].to_vec(), done))
                .await
                .context("SSH stdout writer stopped")?;
            ack.await
                .context("SSH stdout writer stopped")?
                .context("write SSH proxy stdout")?;
        }
    };
    tokio::pin!(download);
    tokio::select! {
        result = &mut download => result,
        result = upload => { result?; download.await }
    }
}

#[cfg(test)]
#[path = "tests/proxy.rs"]
mod tests;
