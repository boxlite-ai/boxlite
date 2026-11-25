use std::{
    fs,
    io::{self, BufRead, BufReader},
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};

use crate::{
    BoxliteError, BoxliteResult,
    jailer::shim_copy::copy_shim_to_box,
    net::{OutboundCapabilities, OutboundRevision},
};

const PIN_DIR: &str = "hosted-rebuild-shims";
const BOX_PIN_DIR: &str = "hosted-rebuild";
const SHIM: &str = "boxlite-shim";

/// Probe the copied executable and retain its immutable bundle across Runner
/// restart. Distinct versions share a cache across targets by content hash.
pub(crate) async fn pin_rebuild_shim(
    runtime_home: &Path,
    required: OutboundCapabilities,
) -> BoxliteResult<OutboundRevision> {
    let root = runtime_home.join(PIN_DIR);
    let source = crate::util::find_binary(SHIM)?;
    let (pin, path) = tokio::task::spawn_blocking(move || {
        fs::create_dir_all(&root).map_err(pin_io)?;
        let staging = tempfile::tempdir_in(&root).map_err(pin_io)?;
        let copied = copy_shim_to_box(&source, staging.path())?;
        let hash = hash_bundle(&copied).map_err(pin_io)?;
        sync_directory(staging.path()).map_err(pin_io)?;
        let destination = root.join(&hash);
        match fs::rename(staging.path(), &destination) {
            Ok(()) => (),
            Err(_) if destination.is_dir() => (),
            Err(error) => return Err(pin_io(error)),
        }
        sync_parent(&destination).map_err(pin_io)?;
        sync_parent(&root).map_err(pin_io)?;
        Ok::<_, BoxliteError>((OutboundRevision::parse(hash)?, shim_in(&destination)))
    })
    .await
    .map_err(|error| BoxliteError::Internal(format!("join rebuild shim copy: {error}")))??;
    super::shim::probe_outbound_capabilities_at(path)
        .await?
        .require(required)?;
    Ok(pin)
}

pub(crate) async fn copy_rebuild_shim(
    runtime_home: &Path,
    box_home: &Path,
    pin: &OutboundRevision,
    required: OutboundCapabilities,
) -> BoxliteResult<()> {
    let source = shim_in(&runtime_home.join(PIN_DIR).join(pin.as_str()));
    let box_home = box_home.to_path_buf();
    let pin = pin.clone();
    let copied = tokio::task::spawn_blocking(move || {
        if hash_bundle(&source).map_err(pin_io)? != pin.as_str() {
            return Err(BoxliteError::InvalidState(
                "invalid rebuild shim pin".into(),
            ));
        }
        let destination = box_home.join(BOX_PIN_DIR);
        let copied = copy_shim_to_box(&source, &destination)?;
        if hash_bundle(&copied).map_err(pin_io)? != pin.as_str() {
            return Err(BoxliteError::InvalidState(
                "invalid rebuild shim copy".into(),
            ));
        }
        sync_directory(&destination).map_err(pin_io)?;
        sync_directory(&box_home).map_err(pin_io)?;
        sync_parent(&box_home).map_err(pin_io)?;
        Ok(copied)
    })
    .await
    .map_err(|error| BoxliteError::Internal(format!("join rebuild shim copy: {error}")))??;
    super::shim::probe_outbound_capabilities_at(copied)
        .await?
        .require(required)
}

pub(crate) fn rebuild_shim_for_box(box_home: &Path) -> BoxliteResult<PathBuf> {
    let pin = box_home.join(BOX_PIN_DIR);
    if pin.try_exists().map_err(pin_io)? {
        return Ok(shim_in(&pin));
    }
    crate::util::find_binary(SHIM)
}

fn shim_in(root: &Path) -> PathBuf {
    root.join("bin").join(SHIM)
}

fn hash_bundle(shim: &Path) -> io::Result<String> {
    let dir = shim.with_file_name("");
    let mut files = fs::read_dir(&dir)?.collect::<io::Result<Vec<_>>>()?;
    files.sort_by_key(fs::DirEntry::file_name);
    let mut hash = Sha256::new();
    for entry in files {
        let file = fs::File::open(entry.path())?;
        file.sync_all()?;
        let name = entry.file_name();
        let name = name.as_encoded_bytes();
        hash.update(name.len().to_be_bytes());
        hash.update(name);
        hash.update(file.metadata()?.len().to_be_bytes());
        let mut reader = BufReader::new(file);
        loop {
            let bytes = reader.fill_buf()?;
            if bytes.is_empty() {
                break;
            }
            hash.update(bytes);
            let len = bytes.len();
            reader.consume(len);
        }
    }
    sync_directory(&dir)?;
    Ok(hex::encode(hash.finalize()))
}

fn sync_directory(path: &Path) -> io::Result<()> {
    fs::File::open(path)?.sync_all()
}

fn sync_parent(path: &Path) -> io::Result<()> {
    sync_directory(path.parent().ok_or(io::ErrorKind::InvalidInput)?)
}

fn pin_io(error: io::Error) -> BoxliteError {
    BoxliteError::Storage(format!("rebuild shim storage: {error}"))
}
