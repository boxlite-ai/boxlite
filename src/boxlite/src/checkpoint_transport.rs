//! Shared, temporary HTTP representation of a native checkpoint pair.
//! This module is public only for the separate reference-server crate.
use crate::litebox::checkpoint::pair::{self, DISK, MEMORY, invalid};
use crate::{BoxliteError, BoxliteResult};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

/// Pack a verified pair into an anonymous temporary tar+zstd file.
pub fn pack(directory: &Path) -> BoxliteResult<File> {
    let mut pair = pair::open(directory)?;
    require_relocatable(&pair)?;
    pair.verify_disk()?;
    let output = tempfile::tempfile().map_err(invalid)?;
    let mut encoder = zstd::stream::write::Encoder::new(output, 1).map_err(invalid)?;
    encoder.include_checksum(true).map_err(invalid)?;
    let mut archive = tar::Builder::new(encoder);
    for (name, file) in [(MEMORY, &mut pair.memory), (DISK, &mut pair.disk)] {
        file.seek(SeekFrom::Start(0)).map_err(invalid)?;
        let mut header = tar::Header::new_ustar();
        header.set_size(file.metadata().map_err(invalid)?.len());
        header.set_mode(0o600);
        header.set_entry_type(tar::EntryType::Regular);
        header.set_cksum();
        archive
            .append_data(&mut header, name, file)
            .map_err(invalid)?;
    }
    let mut output = archive
        .into_inner()
        .map_err(invalid)?
        .finish()
        .map_err(invalid)?;
    output.seek(SeekFrom::Start(0)).map_err(invalid)?;
    Ok(output)
}

/// Decode and verify before publishing a new, caller-owned two-file directory.
/// The destination must not exist. No network or VM operation runs here.
pub fn unpack(mut input: File, destination: &Path) -> BoxliteResult<()> {
    let destination = std::path::absolute(destination).map_err(invalid)?;
    let parent = destination
        .parent()
        .ok_or_else(|| invalid("destination has no parent"))?
        .canonicalize()
        .map_err(invalid)?;
    let name = destination
        .file_name()
        .ok_or_else(|| invalid("destination has no name"))?;
    let destination = parent.join(name);
    if destination.symlink_metadata().is_ok() {
        return Err(BoxliteError::AlreadyExists(
            destination.display().to_string(),
        ));
    }
    let staging = tempfile::Builder::new()
        .prefix(".boxlite-checkpoint-transfer-")
        .tempdir_in(&parent)
        .map_err(invalid)?;
    input.seek(SeekFrom::Start(0)).map_err(invalid)?;
    let decoder = zstd::stream::read::Decoder::new(input).map_err(invalid)?;
    let mut archive = tar::Archive::new(decoder);
    let mut members = std::collections::BTreeSet::new();
    for entry in archive.entries().map_err(invalid)?.raw(true) {
        let mut entry = entry.map_err(invalid)?;
        let name = match entry.path_bytes().as_ref() {
            b"snapshot.mem" => MEMORY,
            b"snapshot.qcow2" => DISK,
            _ => {
                return Err(invalid(
                    "checkpoint transport has an extra or invalid member",
                ));
            }
        };
        if entry.header().entry_type() != tar::EntryType::Regular || !members.insert(name) {
            return Err(invalid(
                "checkpoint transport has a duplicate or nonregular member",
            ));
        }
        let size = entry.size();
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(staging.path().join(name))
            .map_err(invalid)?;
        if std::io::copy(&mut entry, &mut output).map_err(invalid)? != size {
            return Err(invalid("incomplete checkpoint transport member"));
        }
        output.sync_all().map_err(invalid)?;
    }
    if members.len() != 2 {
        return Err(invalid("checkpoint transport requires exactly two members"));
    }
    // tar stops at its first zero block. Drain the decoder to validate the
    // zstd frame/trailer too, and reject hidden entries after the tar footer.
    let mut decoder = archive.into_inner();
    let mut buffer = [0; 8192];
    let mut tail = 0;
    loop {
        let count = decoder.read(&mut buffer).map_err(invalid)?;
        if count == 0 {
            break;
        }
        tail += count;
        if tail > 65536 || buffer[..count].iter().any(|&byte| byte != 0) {
            return Err(invalid("invalid checkpoint transport trailer"));
        }
    }
    if tail < 512 || tail % 512 != 0 {
        return Err(invalid("incomplete checkpoint transport footer"));
    }
    let pair = pair::open(staging.path())?;
    require_relocatable(&pair)?;
    pair.verify_disk()?;
    drop(pair);
    File::open(staging.path())
        .and_then(|file| file.sync_all())
        .map_err(invalid)?;
    rename_exclusive(staging.path(), &destination)?;
    let _ = staging.keep();
    File::open(parent)
        .and_then(|file| file.sync_all())
        .map_err(invalid)
}

fn require_relocatable(pair: &pair::VerifiedPair) -> BoxliteResult<()> {
    if pair.dependencies.application["local_paths"]["version"] != 2 {
        return Err(BoxliteError::Unsupported(
            "REST import requires checkpoint path metadata v2; re-export the checkpoint with a current runtime".into(),
        ));
    }
    Ok(())
}

fn rename_exclusive(source: &Path, destination: &Path) -> BoxliteResult<()> {
    use std::os::unix::ffi::OsStrExt;
    let source = std::ffi::CString::new(source.as_os_str().as_bytes()).map_err(invalid)?;
    let destination =
        std::ffi::CString::new(destination.as_os_str().as_bytes()).map_err(invalid)?;
    #[cfg(target_os = "linux")]
    // SAFETY: both strings are NUL-terminated paths. Never replace a destination.
    let result = unsafe {
        libc::renameat2(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    #[cfg(target_os = "macos")]
    // SAFETY: same exclusive directory-rename contract on caller-local macOS.
    let result =
        unsafe { libc::renamex_np(source.as_ptr(), destination.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let result = -1;
    if result != 0 {
        return Err(invalid(std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(all(test, feature = "rest"))]
mod tests {
    use super::*;
    use crate::BoxliteRestOptions;
    use crate::rest::client::ApiClient;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn head(stream: &mut tokio::net::TcpStream) -> String {
        let mut bytes = Vec::new();
        while !bytes.ends_with(b"\r\n\r\n") {
            bytes.push(stream.read_u8().await.unwrap());
        }
        String::from_utf8(bytes).unwrap()
    }

    #[tokio::test]
    async fn checkpoint_http_download_upload_use_base_prefix_and_complete_files() {
        let source = crate::litebox::checkpoint::pair::tests::fixture();
        let file = pack(source.path()).unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let client = ApiClient::new(
            &BoxliteRestOptions::new(format!("http://{}/base", listener.local_addr().unwrap()))
                .with_path_prefix("region/team"),
        )
        .unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            assert!(
                head(&mut stream)
                    .await
                    .starts_with("POST /base/v1/region/team/boxes/id/checkpoint/export ")
            );
            let mut file = tokio::fs::File::from_std(file);
            stream
                .write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        file.metadata().await.unwrap().len()
                    )
                    .as_bytes(),
                )
                .await
                .unwrap();
            tokio::io::copy(&mut file, &mut stream).await.unwrap();
            drop(stream);
            let (mut stream, _) = listener.accept().await.unwrap();
            let header = head(&mut stream).await;
            assert!(
                header.starts_with("POST /base/v1/region/team/boxes/checkpoint/import?name=a+b "),
                "{header}"
            );
            let length: usize = header
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length: ")
                        .map(str::to_owned)
                })
                .unwrap()
                .parse()
                .unwrap();
            let mut output = tokio::fs::File::from_std(tempfile::tempfile().unwrap());
            let copied = tokio::io::copy(&mut (&mut stream).take(length as u64), &mut output)
                .await
                .unwrap();
            assert_eq!(copied, length as u64);
            output.flush().await.unwrap();
            let target = tempfile::tempdir().unwrap();
            unpack(output.into_std().await, &target.path().join("pair")).unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 201 Created\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}",
                )
                .await
                .unwrap();
        });
        let file = client
            .download_checkpoint("/boxes/id/checkpoint/export")
            .await
            .unwrap();
        let home = tempfile::tempdir().unwrap();
        unpack(file, &home.path().join("pair")).unwrap();
        let _: serde_json::Value = client
            .post_checkpoint(pack(&home.path().join("pair")).unwrap(), Some("a b"))
            .await
            .unwrap();
        server.await.unwrap();
    }

    #[tokio::test]
    async fn checkpoint_http_disconnect_and_missing_capability_fail_explicitly() {
        for case in 0..4 {
            let truncated = case == 3;
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let client = ApiClient::new(&BoxliteRestOptions::new(format!(
                "http://{}",
                listener.local_addr().unwrap()
            )))
            .unwrap();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let header = head(&mut stream).await;
                if truncated {
                    assert!(header.starts_with("POST /v1/boxes/id/checkpoint/export "));
                    stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 999\r\nConnection: close\r\n\r\npartial").await.unwrap();
                } else {
                    assert!(header.starts_with("GET /v1/config "));
                    let (status, body) = match case {
                        0 => ("200 OK", r#"{"capabilities":{}}"#),
                        1 => (
                            "200 OK",
                            r#"{"capabilities":{"checkpoints_enabled":false}}"#,
                        ),
                        _ => ("404 Not Found", "no config endpoint"),
                    };
                    stream.write_all(format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).as_bytes()).await.unwrap();
                }
            });
            let error = if truncated {
                client
                    .download_checkpoint("/boxes/id/checkpoint/export")
                    .await
                    .unwrap_err()
            } else {
                client.require_checkpoints_enabled().await.unwrap_err()
            };
            if truncated {
                assert!(matches!(error, BoxliteError::Network(..)), "{error}");
            } else {
                assert!(matches!(error, BoxliteError::Unsupported(_)), "{error}");
            }
            server.await.unwrap();
        }
    }

    #[tokio::test]
    async fn checkpoint_http_import_response_loss_does_not_retry_or_follow_redirects() {
        for redirect in [false, true] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let client = ApiClient::new(&BoxliteRestOptions::new(&url)).unwrap();
            let source = crate::litebox::checkpoint::pair::tests::fixture();
            let file = pack(source.path()).unwrap();
            let length = file.metadata().unwrap().len();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                assert!(
                    head(&mut stream)
                        .await
                        .starts_with("POST /v1/boxes/checkpoint/import ")
                );
                assert_eq!(
                    tokio::io::copy(&mut (&mut stream).take(length), &mut tokio::io::sink())
                        .await
                        .unwrap(),
                    length
                );
                if redirect {
                    stream.write_all(format!("HTTP/1.1 307 Temporary Redirect\r\nLocation: {url}/replayed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
                }
                drop(stream);
                assert!(
                    tokio::time::timeout(std::time::Duration::from_millis(200), listener.accept())
                        .await
                        .is_err(),
                    "import sent another request"
                );
            });
            let result = client
                .post_checkpoint::<serde_json::Value>(file, None)
                .await;
            assert!(result.is_err());
            server.await.unwrap();
        }
    }
}
