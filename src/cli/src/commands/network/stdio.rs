//! Cancellable stdio: Tokio's stdin uses a blocking worker that can keep the
//! runtime alive after the peer exits while a pipe's writer remains open.

use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsFd, AsRawFd, RawFd};
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::pin::Pin;
use std::task::{Context, Poll, ready};

use nix::fcntl::{FcntlArg, OFlag, fcntl};
use tokio::io::unix::AsyncFd;
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadBuf};

pub(super) async fn run(connection: boxlite::BoxConnection) -> anyhow::Result<()> {
    let input = Descriptor::new(&std::io::stdin())?;
    let output = Descriptor::new(&std::io::stdout())?;
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! {
        result = relay(input, output, connection) => result?,
        result = tokio::signal::ctrl_c() => result?,
        _ = terminate.recv() => (),
    }
    Ok(())
}

async fn relay(
    mut input: impl AsyncRead + Unpin,
    mut output: impl AsyncWrite + Unpin,
    connection: impl AsyncRead + AsyncWrite + Unpin,
) -> io::Result<()> {
    let (mut reader, mut writer) = tokio::io::split(connection);
    let upload = async {
        tokio::io::copy(&mut input, &mut writer).await?;
        writer.shutdown().await
    };
    let download = async {
        tokio::io::copy(&mut reader, &mut output).await?;
        output.flush().await
    };
    tokio::pin!(upload, download);
    tokio::select! {
        result = &mut upload => { result?; download.await }
        result = &mut download => result,
    }
}

struct NonblockingFile {
    file: File,
    original_flags: OFlag,
}

impl AsRawFd for NonblockingFile {
    fn as_raw_fd(&self) -> RawFd {
        self.file.as_raw_fd()
    }
}

impl Drop for NonblockingFile {
    fn drop(&mut self) {
        if let Err(error) = fcntl(&self.file, FcntlArg::F_SETFL(self.original_flags)) {
            tracing::warn!(%error, "restore stdio descriptor flags");
        }
    }
}

enum Descriptor {
    Regular(File),
    Pollable(AsyncFd<NonblockingFile>),
}

impl Descriptor {
    fn new(source: &impl AsFd) -> io::Result<Self> {
        let file = File::from(source.as_fd().try_clone_to_owned()?);
        // Regular file reads cannot wait for a producer and epoll/kqueue cannot
        // consistently register them. Pipes, sockets, and terminals use readiness.
        let metadata = file.metadata()?;
        let is_immediate_device = metadata.file_type().is_char_device()
            && ["/dev/null", "/dev/zero"].iter().any(|path| {
                std::fs::metadata(path).is_ok_and(|device| device.rdev() == metadata.rdev())
            });
        if metadata.is_file() || is_immediate_device {
            return Ok(Self::Regular(file));
        }
        let original_flags = OFlag::from_bits_truncate(fcntl(&file, FcntlArg::F_GETFL)?);
        let guarded = NonblockingFile {
            file,
            original_flags,
        };
        fcntl(
            &guarded.file,
            FcntlArg::F_SETFL(original_flags | OFlag::O_NONBLOCK),
        )?;
        Ok(Self::Pollable(AsyncFd::new(guarded)?))
    }
}

impl AsyncRead for Descriptor {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let count = match self.get_mut() {
            Self::Regular(file) => (&*file).read(buf.initialize_unfilled())?,
            Self::Pollable(file) => loop {
                let mut guard = ready!(file.poll_read_ready(cx))?;
                match guard.try_io(|file| (&file.get_ref().file).read(buf.initialize_unfilled())) {
                    Ok(result) => break result?,
                    Err(_) => continue,
                }
            },
        };
        buf.advance(count);
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for Descriptor {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Self::Regular(file) => Poll::Ready((&*file).write(bytes)),
            Self::Pollable(file) => loop {
                let mut guard = ready!(file.poll_write_ready(cx))?;
                match guard.try_io(|file| (&file.get_ref().file).write(bytes)) {
                    Ok(result) => return Poll::Ready(result),
                    Err(_) => continue,
                }
            },
        }
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncReadExt;

    #[tokio::test]
    async fn ssh_stdio_half_close_preserves_raw_response() {
        let (local, mut remote) = tokio::io::duplex(64);
        let (output, mut result) = tokio::io::duplex(64);
        let transport = tokio::spawn(relay(&b"\0\xffrequest"[..], output, local));
        let mut request = Vec::new();
        remote.read_to_end(&mut request).await.unwrap();
        assert_eq!(request, b"\0\xffrequest");
        remote.write_all(b"\xff\0response").await.unwrap();
        remote.shutdown().await.unwrap();
        let mut response = Vec::new();
        result.read_to_end(&mut response).await.unwrap();
        transport.await.unwrap().unwrap();
        assert_eq!(response, b"\xff\0response");
    }

    #[tokio::test]
    async fn ssh_stdio_remote_eof_cancels_open_stdin() {
        let (input, _open_writer) = tokio::io::duplex(64);
        let (local, mut remote) = tokio::io::duplex(64);
        remote.shutdown().await.unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(1),
            relay(input, tokio::io::sink(), local),
        )
        .await
        .unwrap()
        .unwrap();
    }
}
