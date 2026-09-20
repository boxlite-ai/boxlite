//! Runner-owned, local-only OverlayBD images and shared read-only UBLK devices.
//! The upstream daemon owns device processes; persisted boxes own image identity.

use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;

use boxlite_shared::{BoxliteError, BoxliteResult};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::ContainerImageConfig;
use crate::disk::{BackingFormat, Disk, DiskFormat, Qcow2Helper};

const MAX_JSON: u64 = 4 * 1024 * 1024;
const SOCKET: &str = "/var/run/overlaybd-ublk/ublkd.sock";

fn error(message: impl std::fmt::Display) -> BoxliteError {
    BoxliteError::Storage(format!("OverlayBD: {message}"))
}

pub(crate) fn image_digest(reference: &str) -> BoxliteResult<&str> {
    let (_, digest) = reference.rsplit_once('@').ok_or_else(|| {
        error("image reference must pin a converted single-platform manifest with @sha256:...")
    })?;
    digest_hex(digest)
}

fn digest_hex(digest: &str) -> BoxliteResult<&str> {
    let hex = digest
        .strip_prefix("sha256:")
        .ok_or_else(|| error("expected sha256 digest"))?;
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err(error("invalid sha256 digest"));
    }
    Ok(hex)
}

#[derive(Deserialize)]
struct Blob {
    digest: String,
    size: u64,
    #[serde(default)]
    annotations: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct Manifest {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    config: Blob,
    layers: Vec<Blob>,
}

#[derive(Debug, Deserialize)]
struct Device {
    dev_id: u32,
    dev: PathBuf,
    config: PathBuf,
    writable: bool,
    state: String,
}

pub(crate) struct Overlaybd {
    root: PathBuf,
    source: Option<PathBuf>,
    socket: PathBuf,
    // ponytail: serialize device transitions; split per image if startup throughput requires it.
    users: Mutex<BTreeMap<String, BTreeSet<String>>>,
}

pub(crate) struct Lease {
    owner: Arc<Overlaybd>,
    box_id: String,
    armed: bool,
}

impl Lease {
    pub(crate) fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if self.armed
            && let Err(e) = self.owner.release(&self.box_id)
        {
            tracing::warn!(box_id = %self.box_id, error = %e, "Failed to release OverlayBD device; recovery will retry");
        }
    }
}

impl Overlaybd {
    pub(crate) fn new(home: &Path, source: Option<PathBuf>) -> BoxliteResult<Arc<Self>> {
        if source.is_some() && !cfg!(target_os = "linux") {
            return Err(BoxliteError::Unsupported(
                "OverlayBD requires a Linux cloud runner".into(),
            ));
        }
        if let Some(path) = &source
            && (!path.is_absolute() || !path.is_dir())
        {
            return Err(error(
                "image directory must be an existing absolute OCI layout directory",
            ));
        }
        Ok(Arc::new(Self {
            root: home.join("overlaybd"),
            source,
            socket: SOCKET.into(),
            users: Mutex::new(BTreeMap::new()),
        }))
    }

    pub(crate) fn enabled(&self) -> bool {
        self.source.is_some()
    }

    fn blob_path(root: &Path, digest: &str) -> BoxliteResult<PathBuf> {
        Ok(root.join("blobs/sha256").join(digest_hex(digest)?))
    }

    fn read_json(path: &Path) -> BoxliteResult<Vec<u8>> {
        let mut bytes = Vec::new();
        File::open(path)
            .and_then(|f| f.take(MAX_JSON + 1).read_to_end(&mut bytes))
            .map_err(|e| error(format!("read {}: {e}", path.display())))?;
        if bytes.len() as u64 > MAX_JSON {
            return Err(error("JSON exceeds 4 MiB"));
        }
        Ok(bytes)
    }

    fn verify(bytes: &[u8], digest: &str) -> BoxliteResult<()> {
        if hex::encode(Sha256::digest(bytes)) != digest_hex(digest)? {
            return Err(error(format!("digest mismatch for {digest}")));
        }
        Ok(())
    }

    fn manifest(root: &Path, reference: &str) -> BoxliteResult<Manifest> {
        let digest = format!("sha256:{}", image_digest(reference)?);
        let bytes = Self::read_json(&Self::blob_path(root, &digest)?)?;
        Self::verify(&bytes, &digest)?;
        let manifest: Manifest = serde_json::from_slice(&bytes).map_err(error)?;
        if manifest.schema_version != 2 || manifest.layers.is_empty() || manifest.layers.len() > 128
        {
            return Err(error(
                "expected a single-platform manifest with 1..128 layers",
            ));
        }
        for layer in &manifest.layers {
            if layer
                .annotations
                .get("containerd.io/snapshot/overlaybd/version")
                .map(String::as_str)
                != Some("0.1.0")
            {
                return Err(error("only native OverlayBD 0.1.0 layers are supported"));
            }
            if layer
                .annotations
                .get("containerd.io/snapshot/overlaybd/blob-digest")
                != Some(&layer.digest)
            {
                return Err(error(
                    "layer blob digest annotation must match its descriptor",
                ));
            }
        }
        Ok(manifest)
    }

    fn copy_blob(&self, source: &Path, blob: &Blob) -> BoxliteResult<()> {
        let dst = Self::blob_path(&self.root, &blob.digest)?;
        let src = if dst.exists() {
            dst.clone()
        } else {
            Self::blob_path(source, &blob.digest)?
        };
        let mut input = File::open(&src).map_err(error)?;
        let metadata = input.metadata().map_err(error)?;
        if !metadata.is_file() || metadata.len() != blob.size {
            return Err(error(format!("invalid blob size/type: {}", src.display())));
        }
        fs::create_dir_all(dst.parent().unwrap()).map_err(error)?;
        let mut staged = tempfile::NamedTempFile::new_in(dst.parent().unwrap()).map_err(error)?;
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 65536];
        loop {
            let n = input.read(&mut buffer).map_err(error)?;
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
            if src != dst {
                staged.write_all(&buffer[..n]).map_err(error)?;
            }
        }
        if hex::encode(hash.finalize()) != digest_hex(&blob.digest)? {
            return Err(error(format!("digest mismatch for {}", blob.digest)));
        }
        if src != dst {
            staged.as_file().sync_all().map_err(error)?;
            match staged.persist_noclobber(&dst) {
                Ok(_) => {}
                Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(error(e)),
            }
        }
        Ok(())
    }

    /// Import and pin verified local blobs before recording a new box. No registry access.
    pub(crate) fn import(&self, reference: &str) -> BoxliteResult<()> {
        let source = self
            .source
            .as_ref()
            .ok_or_else(|| error("backend is disabled"))?;
        let digest = format!("sha256:{}", image_digest(reference)?);
        let manifest = Self::manifest(source, reference)?;
        self.copy_blob(source, &manifest.config)?;
        self.image_config(&manifest)?;
        for layer in &manifest.layers {
            self.copy_blob(source, layer)?;
        }
        let size = fs::metadata(Self::blob_path(source, &digest)?)
            .map_err(error)?
            .len();
        self.copy_blob(
            source,
            &Blob {
                digest,
                size,
                annotations: BTreeMap::new(),
            },
        )
    }

    fn image_config(&self, manifest: &Manifest) -> BoxliteResult<ContainerImageConfig> {
        let bytes = Self::read_json(&Self::blob_path(&self.root, &manifest.config.digest)?)?;
        Self::verify(&bytes, &manifest.config.digest)?;
        let config: oci_spec::image::ImageConfiguration =
            serde_json::from_slice(&bytes).map_err(error)?;
        let arch = match std::env::consts::ARCH {
            "x86_64" => "amd64",
            "aarch64" => "arm64",
            other => other,
        };
        if config.os().to_string() != "linux" || config.architecture().to_string() != arch {
            return Err(error(format!("image must target linux/{arch}")));
        }
        ContainerImageConfig::from_oci_config(&config)
    }

    fn config_path(&self, digest: &str) -> PathBuf {
        self.root.join("devices").join(format!("{digest}.json"))
    }

    // curl is the upstream documented UDS client, also installed in the runner image.
    // Disable user curl configuration/proxies and bound both time and response size.
    fn request(&self, operation: &str, body: Option<Value>) -> BoxliteResult<Value> {
        let output = tempfile::NamedTempFile::new().map_err(error)?;
        let mut cmd = Command::new("/usr/bin/curl");
        cmd.args([
            "--disable",
            "--silent",
            "--show-error",
            "--fail",
            "--noproxy",
            "*",
            "--connect-timeout",
            "5",
            "--max-time",
            "30",
            "--max-filesize",
            "1048576",
            "--unix-socket",
        ])
        .arg(&self.socket)
        .arg("--output")
        .arg(output.path());
        if let Some(body) = body {
            cmd.args(["--request", "POST", "--data-binary", &body.to_string()]);
        }
        let status = cmd
            .arg(format!("http://localhost/v1/{operation}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(error)?;
        if !status.success() {
            return Err(error(format!(
                "daemon {operation} at {} failed ({status}); check daemon log",
                self.socket.display()
            )));
        }
        let response: Value =
            serde_json::from_slice(&Self::read_json(output.path())?).map_err(error)?;
        if response.get("ok").and_then(Value::as_bool) != Some(true) {
            return Err(error(format!("daemon {operation} returned failure")));
        }
        Ok(response)
    }

    fn devices(&self) -> BoxliteResult<Vec<Device>> {
        serde_json::from_value(
            self.request("list", None)?
                .get("devices")
                .cloned()
                .ok_or_else(|| error("missing device list"))?,
        )
        .map_err(error)
    }

    fn matching_device(&self, digest: &str) -> BoxliteResult<Option<Device>> {
        let matches: Vec<_> = self
            .devices()?
            .into_iter()
            .filter(|d| d.config == self.config_path(digest))
            .collect();
        if matches.len() > 1 {
            return Err(error(
                "duplicate devices for one image; operator reconciliation required",
            ));
        }
        let device = matches.into_iter().next();
        if let Some(d) = &device
            && (d.writable
                || d.state != "running"
                || d.dev != Path::new(&format!("/dev/ublkb{}", d.dev_id)))
        {
            return Err(error("expected a running read-only UBLK device"));
        }
        Ok(device)
    }

    fn acquire(self: &Arc<Self>, box_id: &str, digest: &str) -> BoxliteResult<(PathBuf, Lease)> {
        let mut users = self.users.lock();
        let device = match self.matching_device(digest)? {
            Some(device) => device,
            None => {
                if users.get(digest).is_some_and(|ids| !ids.is_empty()) {
                    return Err(error(
                        "device disappeared while boxes still hold it; stop those boxes before restarting",
                    ));
                }
                // An ambiguous timeout leaves the config identity discoverable by list/recovery.
                self.request("add", Some(json!({"config": self.config_path(digest)})))?;
                self.matching_device(digest)?
                    .ok_or_else(|| error("created device missing from daemon list"))?
            }
        };
        users
            .entry(digest.into())
            .or_default()
            .insert(box_id.into());
        Ok((
            device.dev,
            Lease {
                owner: self.clone(),
                box_id: box_id.into(),
                armed: true,
            },
        ))
    }

    pub(crate) fn prepare(
        self: &Arc<Self>,
        box_id: &str,
        reference: &str,
        disk_path: &Path,
        size_gb: Option<u64>,
    ) -> BoxliteResult<(ContainerImageConfig, Disk, Lease)> {
        if !self.enabled() {
            return Err(BoxliteError::Unsupported(
                "OverlayBD is disabled for this runner".into(),
            ));
        }
        let digest = image_digest(reference)?;
        let manifest = Self::manifest(&self.root, reference)?;
        let config = self.image_config(&manifest)?;
        let mut lowers = Vec::new();
        for layer in &manifest.layers {
            self.copy_blob(&self.root, layer)?;
            lowers.push(json!({"file": Self::blob_path(&self.root, &layer.digest)?}));
        }
        let path = self.config_path(digest);
        fs::create_dir_all(path.parent().unwrap()).map_err(error)?;
        if !path.exists() {
            let mut staged =
                tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(error)?;
            serde_json::to_writer(&mut staged, &json!({"lowers": lowers})).map_err(error)?;
            staged.as_file().sync_all().map_err(error)?;
            match staged.persist_noclobber(&path) {
                Ok(_) => {}
                Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(e) => return Err(error(e)),
            }
        } else {
            let stored: Value = serde_json::from_slice(&Self::read_json(&path)?).map_err(error)?;
            if stored != json!({"lowers": lowers}) {
                return Err(error("persisted device config differs from pinned image"));
            }
        }
        let (device, lease) = self.acquire(box_id, digest)?;
        let capacity = device_capacity(&device)?;
        let disk = prepare_cow(disk_path, &device, capacity, size_gb)?;
        Ok((config, disk, lease))
    }

    /// Called only after a shim is stopped; failed releases retain ownership for retry.
    pub(crate) fn release(&self, box_id: &str) -> BoxliteResult<()> {
        let mut users = self.users.lock();
        let Some(digest) = users
            .iter()
            .find(|(_, ids)| ids.contains(box_id))
            .map(|(d, _)| d.clone())
        else {
            return Ok(());
        };
        if users[&digest].len() == 1 {
            if let Some(device) = self.matching_device(&digest)? {
                self.request("del", Some(json!({"dev_id": device.dev_id})))?;
            }
            users.remove(&digest);
        } else {
            users.get_mut(&digest).unwrap().remove(box_id);
        }
        Ok(())
    }

    /// Rebuild ownership from surviving shims, then reclaim only this runtime's orphans.
    pub(crate) fn recover(&self, active: BTreeMap<String, BTreeSet<String>>) -> BoxliteResult<()> {
        *self.users.lock() = active;
        if !self.root.join("devices").exists() {
            return Ok(());
        }
        for device in self.devices()? {
            let Some(name) = device.config.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if digest_hex(&format!("sha256:{name}")).is_err()
                || device.config != self.config_path(name)
            {
                continue;
            }
            if !self.users.lock().contains_key(name) {
                self.request("del", Some(json!({"dev_id": device.dev_id})))?;
            }
        }
        Ok(())
    }
}

fn device_capacity(path: &Path) -> BoxliteResult<u64> {
    #[cfg(target_os = "linux")]
    {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::FileTypeExt;
        let file = File::open(path).map_err(error)?;
        if !file
            .metadata()
            .map_err(error)?
            .file_type()
            .is_block_device()
        {
            return Err(error("backing is not a block device"));
        }
        let mut readonly: libc::c_int = 0;
        // BLKROGET reports the kernel-enforced read-only flag, not daemon metadata.
        if unsafe { libc::ioctl(file.as_raw_fd(), 0x125e as libc::c_ulong, &mut readonly) } < 0 {
            return Err(error(std::io::Error::last_os_error()));
        }
        if readonly != 1 {
            return Err(error("backing block device is writable"));
        }
        let mut size: u64 = 0;
        // BLKGETSIZE64 writes one u64 to a valid output pointer; metadata.len() is zero for devices.
        if unsafe { libc::ioctl(file.as_raw_fd(), 0x80081272 as libc::c_ulong, &mut size) } < 0 {
            return Err(error(std::io::Error::last_os_error()));
        }
        if size == 0 {
            return Err(error("block device has zero capacity"));
        }
        Ok(size)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = path;
        Err(BoxliteError::Unsupported(
            "OverlayBD devices require Linux".into(),
        ))
    }
}

fn prepare_cow(
    path: &Path,
    device: &Path,
    capacity: u64,
    size_gb: Option<u64>,
) -> BoxliteResult<Disk> {
    if path.exists() {
        // The immutable manifest identifies the contents; device numbers are deliberately transient.
        let size = Qcow2Helper::qcow2_virtual_size(path)?;
        if size < capacity {
            return Err(error("existing qcow2 is smaller than its backing device"));
        }
        if crate::disk::read_backing_file_path(path)?.as_deref() != device.to_str() {
            // Never leave a torn qcow2 header after a crash during device rebinding.
            let staged = tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(error)?;
            if reflink_copy::reflink(path, staged.path()).is_err() {
                fs::copy(path, staged.path()).map_err(error)?;
            }
            crate::disk::qcow2::set_backing_file_path(staged.path(), device)?;
            staged.as_file().sync_all().map_err(error)?;
            staged.persist(path).map_err(error)?;
            File::open(path.parent().unwrap())
                .and_then(|f| f.sync_all())
                .map_err(error)?;
        }
    } else {
        let requested = size_gb
            .unwrap_or(0)
            .checked_mul(1024 * 1024 * 1024)
            .ok_or_else(|| error("disk size overflow"))?;
        Qcow2Helper::create_cow_child_disk(
            device,
            BackingFormat::Raw,
            path,
            capacity.max(requested),
        )?
        .leak();
    }
    Ok(Disk::new(path.to_path_buf(), DiskFormat::Qcow2, true))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixListener;

    pub(crate) fn fixture() -> (tempfile::TempDir, Arc<Overlaybd>, String) {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("source");
        let blobs = source.join("blobs/sha256");
        fs::create_dir_all(&blobs).unwrap();
        let write = |bytes: &[u8]| {
            let digest = format!("sha256:{}", hex::encode(Sha256::digest(bytes)));
            fs::write(Overlaybd::blob_path(&source, &digest).unwrap(), bytes).unwrap();
            json!({"digest": digest, "size": bytes.len()})
        };
        let arch = if std::env::consts::ARCH == "aarch64" {
            "arm64"
        } else {
            "amd64"
        };
        let config = write(json!({"architecture": arch, "os": "linux", "rootfs": {"type": "layers", "diff_ids": []}, "config": {"Cmd": ["sleep", "infinity"], "Env": ["MESSAGE=hello"]}}).to_string().as_bytes());
        let mut layer =
            write(b"fixture layer; real device format is covered by the Linux smoke test");
        layer["annotations"] = json!({"containerd.io/snapshot/overlaybd/version": "0.1.0", "containerd.io/snapshot/overlaybd/blob-digest": layer["digest"]});
        let manifest = write(
            json!({"schemaVersion": 2, "config": config, "layers": [layer]})
                .to_string()
                .as_bytes(),
        );
        let reference = format!("example.test/test@{}", manifest["digest"].as_str().unwrap());
        let manager = Arc::new(Overlaybd {
            root: dir.path().join("runtime/overlaybd"),
            source: Some(source),
            socket: dir.path().join("daemon.sock"),
            users: Mutex::new(BTreeMap::new()),
        });
        (dir, manager, reference)
    }

    #[test]
    fn overlaybd_import_pins_verified_local_blobs() {
        let (_dir, manager, reference) = fixture();
        manager.import(&reference).unwrap();
        fs::remove_dir_all(manager.source.as_ref().unwrap()).unwrap();
        let manifest = Overlaybd::manifest(&manager.root, &reference).unwrap();
        let config = manager.image_config(&manifest).unwrap();
        assert_eq!(config.cmd, ["sleep", "infinity"]);
        assert_eq!(config.env, ["MESSAGE=hello"]);
        manager
            .copy_blob(&manager.root, &manifest.layers[0])
            .unwrap();
        fs::write(
            Overlaybd::blob_path(&manager.root, &manifest.layers[0].digest).unwrap(),
            b"corrupt",
        )
        .unwrap();
        assert!(
            manager
                .copy_blob(&manager.root, &manifest.layers[0])
                .is_err()
        );
        assert!(image_digest("example.test/test:latest").is_err());
        assert!(digest_hex("sha256:../../etc/passwd").is_err());
    }

    #[test]
    fn overlaybd_rejects_corrupt_and_non_native_images() {
        let (_dir, manager, reference) = fixture();
        let source = manager.source.as_ref().unwrap();
        let manifest = Overlaybd::manifest(source, &reference).unwrap();
        let blob = Overlaybd::blob_path(source, &manifest.layers[0].digest).unwrap();
        fs::write(blob, vec![0; manifest.layers[0].size as usize]).unwrap();
        assert!(
            manager
                .import(&reference)
                .unwrap_err()
                .to_string()
                .contains("digest mismatch")
        );
        let manifest_path = source
            .join("blobs/sha256")
            .join(image_digest(&reference).unwrap());
        let mut value: Value = serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        value["layers"][0]["annotations"] = json!({});
        let bytes = value.to_string();
        let digest = hex::encode(Sha256::digest(bytes.as_bytes()));
        fs::write(source.join("blobs/sha256").join(&digest), bytes).unwrap();
        assert!(
            manager
                .import(&format!("example.test/test@sha256:{digest}"))
                .unwrap_err()
                .to_string()
                .contains("native OverlayBD")
        );
    }

    #[test]
    fn overlaybd_rebind_preserves_existing_cow_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let first = dir.path().join("device-1");
        let second = dir.path().join("device-2");
        fs::write(&first, vec![0; 65536]).unwrap();
        fs::write(&second, vec![0; 65536]).unwrap();
        let cow = dir.path().join("container.qcow2");
        prepare_cow(&cow, &first, 65536, None).unwrap();
        let before = fs::read(&cow).unwrap();
        prepare_cow(&cow, &second, 65536, None).unwrap();
        let after = fs::read(&cow).unwrap();
        assert_eq!(&before[4096..], &after[4096..]);
        assert_eq!(
            crate::disk::read_backing_file_path(&cow).unwrap().unwrap(),
            second.canonicalize().unwrap().to_str().unwrap()
        );
        assert_eq!(Qcow2Helper::qcow2_virtual_size(&cow).unwrap(), 65536);
        assert!(prepare_cow(&cow, &second, 131072, None).is_err());
    }

    // Exercise the real curl/UDS/JSON boundary; no device or VM is pretended to exist.
    fn daemon(manager: &Overlaybd, requests: usize) -> std::thread::JoinHandle<Vec<String>> {
        let listener = UnixListener::bind(&manager.socket).unwrap();
        std::thread::spawn(move || {
            let mut config = None;
            let mut operations = Vec::new();
            for _ in 0..requests {
                let mut poll = libc::pollfd {
                    fd: listener.as_raw_fd(),
                    events: libc::POLLIN,
                    revents: 0,
                };
                assert_eq!(
                    unsafe { libc::poll(&mut poll, 1, 5000) },
                    1,
                    "daemon request timed out"
                );
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(std::time::Duration::from_secs(3)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                let mut length = 0;
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                    if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                        length = value.trim().parse().unwrap();
                    }
                }
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let path = first.split_whitespace().nth(1).unwrap().to_owned();
                let response = match path.as_str() {
                    "/v1/list" => json!({"ok": true, "devices": config.as_ref().map(|c| vec![json!({"dev_id": 7, "dev": "/dev/ublkb7", "config": c, "writable": false, "state": "running"})]).unwrap_or_default()}),
                    "/v1/add" => {
                        let body: Value = serde_json::from_slice(&body).unwrap();
                        assert!(config.is_none());
                        config = Some(body["config"].as_str().unwrap().to_owned());
                        json!({"ok": true, "dev_id": 7, "dev": "/dev/ublkb7"})
                    },
                    "/v1/del" => {
                        assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["dev_id"], 7);
                        config = None;
                        json!({"ok": true})
                    },
                    _ => panic!("unexpected operation {path}"),
                }.to_string();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    response.len(),
                    response
                )
                .unwrap();
                operations.push(path);
            }
            operations
        })
    }

    #[test]
    fn overlaybd_shares_device_until_last_lease_and_recovers_ownership() {
        let (_dir, manager, reference) = fixture();
        let digest = image_digest(&reference).unwrap();
        fs::create_dir_all(manager.config_path(digest).parent().unwrap()).unwrap();
        let server = daemon(&manager, 7);
        let (_, mut first) = manager.acquire("box-a", digest).unwrap();
        let (_, mut second) = manager.acquire("box-b", digest).unwrap();
        first.disarm();
        second.disarm();
        // Process restart reconstructs leases from surviving shims, without adding another device.
        manager
            .recover(BTreeMap::from([(
                digest.into(),
                BTreeSet::from(["box-a".into(), "box-b".into()]),
            )]))
            .unwrap();
        manager.release("box-a").unwrap();
        assert_eq!(manager.users.lock()[digest].len(), 1);
        manager.release("box-b").unwrap();
        assert!(manager.users.lock().is_empty());
        let ops = server.join().unwrap();
        assert_eq!(ops.iter().filter(|p| *p == "/v1/add").count(), 1);
        assert_eq!(ops.iter().filter(|p| *p == "/v1/del").count(), 1);
    }

    #[test]
    fn overlaybd_failed_preparation_lease_releases_device() {
        let (_dir, manager, reference) = fixture();
        let server = daemon(&manager, 5);
        let (_, lease) = manager
            .acquire("box-a", image_digest(&reference).unwrap())
            .unwrap();
        drop(lease);
        assert!(manager.users.lock().is_empty());
        assert_eq!(server.join().unwrap().last().unwrap(), "/v1/del");
    }
}
