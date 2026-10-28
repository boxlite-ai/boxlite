//! Bounded host-only protocol to the shim's libkrun memory mailbox.

use boxlite_shared::{BoxliteError, BoxliteResult};
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Debug, Default)]
pub(crate) struct MemoryStatus {
    pub max_mib: u32,
    pub requested_mib: u32,
    pub plugged_mib: u32,
    pub mapped_mib: u32,
    pub error: i32,
    pub active: bool,
    pub request_error: i32,
}

pub(crate) async fn request(path: &Path, target: u32) -> BoxliteResult<MemoryStatus> {
    let exchange = async {
        let mut stream = tokio::net::UnixStream::connect(path).await?;
        stream.write_all(&target.to_le_bytes()).await?;
        let mut bytes = [0; 32];
        stream.read_exact(&mut bytes).await?;
        if &bytes[..4] != b"BLM1" {
            return Err(std::io::Error::other("invalid memory control response"));
        }
        let words: Vec<u32> = bytes[4..]
            .as_chunks::<4>()
            .0
            .iter()
            .map(|b| u32::from_le_bytes(*b))
            .collect();
        Ok(MemoryStatus {
            max_mib: words[0],
            requested_mib: words[1],
            plugged_mib: words[2],
            mapped_mib: words[3],
            error: words[4] as i32,
            active: words[5] != 0,
            request_error: words[6] as i32,
        })
    };
    tokio::time::timeout(Duration::from_secs(3), exchange)
        .await
        .map_err(|_| BoxliteError::Engine("shim memory control timed out".into()))?
        .map_err(|e: std::io::Error| BoxliteError::Engine(format!("shim memory control: {e}")))
}

/// A successful submission can continue after this wait times out. Always return
/// its last observed host mapping so the caller can persist partial allocation.
pub(crate) async fn grow(path: &Path, target: u32) -> BoxliteResult<MemoryStatus> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    let mut status = request(path, target).await?;
    loop {
        if status.request_error != 0
            || status.error != 0
            || status.plugged_mib >= target
            || tokio::time::Instant::now() >= deadline
        {
            return Ok(status);
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        match request(path, 0).await {
            Ok(next) => status = next,
            Err(error) => {
                tracing::warn!(%error, "memory resize status unavailable after submission");
                status.error = libc::EIO;
                return Ok(status);
            }
        }
    }
}

#[cfg(feature = "krun")]
pub(crate) fn configure(path: &Path, ctx_id: Option<u32>) -> BoxliteResult<()> {
    use std::io::{Read, Write};
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    use std::os::unix::net::UnixListener;

    if let Ok(metadata) = std::fs::symlink_metadata(path) {
        if !metadata.file_type().is_socket() {
            return Err(BoxliteError::Engine(
                "memory socket path is not a socket".into(),
            ));
        }
        std::fs::remove_file(path)?;
    }
    // A restart at the memory ceiling has no hotplug device. Remove the old
    // socket anyway so initialization cannot mistake it for a live mailbox.
    let Some(ctx_id) = ctx_id else {
        return Ok(());
    };
    let listener = UnixListener::bind(path)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    std::thread::Builder::new()
        .name("memory-control".into())
        .spawn(move || {
            for connection in listener.incoming() {
                let Ok(mut stream) = connection else {
                    break;
                };
                let result = (|| -> std::io::Result<()> {
                    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
                    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
                    let mut bytes = [0; 4];
                    stream.read_exact(&mut bytes)?;
                    let target = u32::from_le_bytes(bytes);
                    let mut status = libkrun_sys::KrunMemoryStatus::default();
                    let mut request_error = if target == 0 {
                        0
                    } else {
                        unsafe { libkrun_sys::krun_request_memory(ctx_id, target) }
                    };
                    let result =
                        unsafe { libkrun_sys::krun_get_memory_status(ctx_id, &mut status) };
                    if result < 0 {
                        request_error = result;
                    }
                    let words = [
                        status.max_mib,
                        status.requested_mib,
                        status.plugged_mib,
                        status.mapped_mib,
                        status.error as u32,
                        status.active,
                        request_error as u32,
                    ];
                    let mut response = [0; 32];
                    response[..4].copy_from_slice(b"BLM1");
                    for (word, bytes) in words.iter().zip(response[4..].as_chunks_mut::<4>().0) {
                        bytes.copy_from_slice(&word.to_le_bytes());
                    }
                    stream.write_all(&response)
                })();
                if let Err(error) = result {
                    tracing::debug!(%error, "memory control connection ended");
                }
            }
        })
        .map_err(|e| BoxliteError::Engine(format!("start memory control: {e}")))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn grow_preserves_partial_mapping_when_the_shim_disconnects() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memory.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let shim = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            assert_eq!(stream.read_u32_le().await.unwrap(), 512);
            stream.write_all(b"BLM1").await.unwrap();
            for word in [1024_u32, 512, 258, 384, 0, 1, 0] {
                stream.write_u32_le(word).await.unwrap();
            }
            let (mut query, _) = listener.accept().await.unwrap();
            assert_eq!(query.read_u32_le().await.unwrap(), 0);
            // A status read failing after submission must retain the observed
            // 128 MiB slot, even though the guest plugged only one 2 MiB block.
        });
        let status = grow(&path, 512).await.unwrap();
        assert_eq!(status.mapped_mib, 384);
        assert_eq!(status.plugged_mib, 258);
        assert_eq!(status.requested_mib, 512);
        assert_eq!(status.error, libc::EIO);
        shim.await.unwrap();
    }

    #[tokio::test]
    async fn request_rejects_an_unknown_protocol() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("memory.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let shim = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            assert_eq!(stream.read_u32_le().await.unwrap(), 0);
            stream.write_all(&[0; 32]).await.unwrap();
        });
        assert!(
            request(&path, 0)
                .await
                .unwrap_err()
                .to_string()
                .contains("invalid memory control response")
        );
        shim.await.unwrap();
    }
}
