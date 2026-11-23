//! Install a host-side agent binary into a running Box (design #2322).
//!
//! The host copies the binary into the Box share under its SHA-256, records
//! the digest outside the share, and mounts the share's agents folder
//! read-only at [`MOUNT_POINT`] in the container, once per VM run. The guest
//! can write the share, so placement never follows a link in it and the host
//! never reads anything back from it.
//!
//! Only tests install for now, through `test-support`; the agent catalog of
//! #2322 is the first production caller of the install path.
#![cfg_attr(
    not(feature = "test-support"),
    allow(
        dead_code,
        reason = "the install path's first production caller is the agent catalog (#2322)"
    )
)]

use std::collections::BTreeMap;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsFd, OwnedFd};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use nix::errno::Errno;
use nix::fcntl::{OFlag, open, openat, renameat};
use nix::sys::stat::{Mode, fchmod, mkdirat};
use nix::unistd::{UnlinkatFlags, unlinkat};
use sha2::{Digest, Sha256};

use crate::litebox::box_impl::BoxImpl;
use crate::{BoxliteError, BoxliteResult};

/// Share folder that holds every agent, under the container's `volumes/`.
const SHARE_FOLDER: &str = "agents";
/// Where the container sees the share folder.
const MOUNT_POINT: &str = "/opt/boxlite/agents";
/// The host record of installed agents, in the Box folder outside the share.
const RECORD_FILE: &str = "agents.json";

/// Installs agents into one Box and finds the installed ones.
pub(crate) struct AgentInstaller {
    box_impl: Arc<BoxImpl>,
}

impl AgentInstaller {
    pub(crate) fn new(box_impl: Arc<BoxImpl>) -> Self {
        Self { box_impl }
    }

    /// Copy `host_file` into the share as `agent`, record it, and mount the
    /// agents folder. Returns the folder that holds the binary in the Box.
    pub(crate) async fn install(&self, agent: &str, host_file: &Path) -> BoxliteResult<String> {
        let _install = self.box_impl.lock_agent_installs().await?;
        let share = AgentShare::new(
            &self.box_impl.layout.mounts_dir(),
            self.box_impl.container_id(),
        );
        let (source, agent) = (host_file.to_path_buf(), agent.to_owned());
        let placed = tokio::task::spawn_blocking(move || {
            share.place(&agent, &source).map(|placed| (agent, placed))
        })
        .await
        .map_err(|error| {
            BoxliteError::Internal(format!("agent placement task failed: {error}"))
        })??;
        let (agent, placed) = placed;
        self.record().insert(&agent, &placed.sha256)?;
        self.box_impl
            .mount_agents_once(SHARE_FOLDER, MOUNT_POINT)
            .await?;
        Ok(placed.dir_in_box)
    }

    /// The Box folder of a recorded `agent`, mounting the agents folder first
    /// when this VM run has not; `None` when the agent was never installed.
    pub(crate) async fn installed(&self, agent: &str) -> BoxliteResult<Option<String>> {
        let Some(sha256) = self.record().get(agent)? else {
            return Ok(None);
        };
        self.box_impl
            .mount_agents_once(SHARE_FOLDER, MOUNT_POINT)
            .await?;
        Ok(Some(dir_in_box(agent, &sha256)))
    }

    fn record(&self) -> InstallRecord {
        InstallRecord::new(self.box_impl.layout.root())
    }
}

fn dir_in_box(agent: &str, sha256: &str) -> String {
    format!("{MOUNT_POINT}/{agent}/{sha256}")
}

/// An agent binary placed in the share.
#[derive(Debug)]
pub(super) struct PlacedAgent {
    pub(super) sha256: String,
    pub(super) dir_in_box: String,
}

/// The agents folder of one container's share, seen from the host:
/// `<share>/containers/<id>/volumes/agents/<agent>/<sha256>/<agent>`.
pub(super) struct AgentShare {
    root: PathBuf,
    container_id: String,
}

impl AgentShare {
    pub(super) fn new(root: &Path, container_id: &str) -> Self {
        Self {
            root: root.to_path_buf(),
            container_id: container_id.to_owned(),
        }
    }

    /// Copy `source` to `<agent>/<sha256>/<agent>`, mode 0555. A folder already
    /// named by the digest is kept. Every folder below the share root is opened
    /// from its parent without following links, so a link the guest planted
    /// fails the call instead of redirecting the write.
    pub(super) fn place(&self, agent: &str, source: &Path) -> BoxliteResult<PlacedAgent> {
        check_component(agent)?;
        let input = File::open(source).map_err(|error| host_file_error(source, error))?;
        // The root is the host's own share folder (on macOS `shared/` is a link
        // the host made), so only the folders below it are opened without links.
        let mut dir = open(
            &self.root,
            OFlag::O_DIRECTORY | OFlag::O_CLOEXEC,
            Mode::empty(),
        )
        .map_err(|errno| share_error(&self.root.display().to_string(), errno))?;
        for component in [
            "containers",
            &self.container_id,
            "volumes",
            SHARE_FOLDER,
            agent,
        ] {
            dir = open_or_create_dir(&dir, component)?;
        }
        let sha256 = stage(&dir, agent, input, source)?;
        Ok(PlacedAgent {
            dir_in_box: dir_in_box(agent, &sha256),
            sha256,
        })
    }
}

/// Copy `input` into a fresh staging folder in `dir`, hashing the bytes it
/// writes, then rename the folder to their digest unless a folder already has
/// that name. The staging folder is removed on every path. Returns the digest.
fn stage(dir: &OwnedFd, agent: &str, input: File, source: &Path) -> BoxliteResult<String> {
    let staging = format!(".staging-{}", uuid::Uuid::new_v4().simple());
    mkdirat(dir, staging.as_str(), Mode::from_bits_truncate(0o755))
        .map_err(|errno| share_error(&staging, errno))?;
    let result = copy_into(dir, &staging, agent, input, source).and_then(|sha256| {
        let renamed = match open_dir(dir, &sha256) {
            Ok(_) => Ok(()),
            Err(Errno::ENOENT) => match renameat(dir, staging.as_str(), dir, sha256.as_str()) {
                // Placed meanwhile; keep the existing folder if it is a real one.
                Err(Errno::EEXIST | Errno::ENOTEMPTY) => open_dir(dir, &sha256).map(drop),
                renamed => renamed,
            },
            Err(errno) => Err(errno),
        };
        renamed
            .map(|()| sha256.clone())
            .map_err(|errno| share_error(&sha256, errno))
    });
    remove_staging(dir, &staging, agent);
    result
}

/// Copy `input` to `<staging>/<agent>` with mode 0555 and return the SHA-256
/// of the bytes written, so the folder name matches the copy, not a re-read.
fn copy_into(
    dir: &OwnedFd,
    staging: &str,
    agent: &str,
    mut input: File,
    source: &Path,
) -> BoxliteResult<String> {
    let staging_dir = open_dir(dir, staging).map_err(|errno| share_error(staging, errno))?;
    let fd = openat(
        &staging_dir,
        agent,
        OFlag::O_WRONLY | OFlag::O_CREAT | OFlag::O_EXCL | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::from_bits_truncate(0o600),
    )
    .map_err(|errno| share_error(agent, errno))?;
    let mut file = File::from(fd);
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|error| host_file_error(source, error))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        file.write_all(&buffer[..read])
            .and_then(|()| file.flush())
            .map_err(|error| {
                BoxliteError::Storage(format!(
                    "cannot write the agent {agent:?} in the Box share: {error}"
                ))
            })?;
    }
    fchmod(file.as_fd(), Mode::from_bits_truncate(0o555))
        .map_err(|errno| share_error(agent, errno))?;
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Remove what is left of a staging folder: the file, then the folder. A
/// renamed folder is gone, so both calls then fail harmlessly.
fn remove_staging(dir: &OwnedFd, staging: &str, agent: &str) {
    if let Ok(staging_dir) = open_dir(dir, staging) {
        let _ = unlinkat(&staging_dir, agent, UnlinkatFlags::NoRemoveDir);
    }
    let _ = unlinkat(dir, staging, UnlinkatFlags::RemoveDir);
}

fn open_dir(dir: &OwnedFd, name: &str) -> nix::Result<OwnedFd> {
    openat(
        dir,
        name,
        OFlag::O_DIRECTORY | OFlag::O_NOFOLLOW | OFlag::O_CLOEXEC,
        Mode::empty(),
    )
}

fn open_or_create_dir(dir: &OwnedFd, name: &str) -> BoxliteResult<OwnedFd> {
    match open_dir(dir, name) {
        Err(Errno::ENOENT) => match mkdirat(dir, name, Mode::from_bits_truncate(0o755)) {
            Ok(()) | Err(Errno::EEXIST) => open_dir(dir, name),
            Err(errno) => Err(errno),
        },
        opened => opened,
    }
    .map_err(|errno| share_error(name, errno))
}

/// A name used as one folder: not empty, not `.` or `..`, no `/` or NUL.
fn check_component(name: &str) -> BoxliteResult<()> {
    if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\0']) {
        return Err(BoxliteError::InvalidArgument(format!(
            "agent name {name:?} must be one folder name"
        )));
    }
    Ok(())
}

fn share_error(name: &str, errno: Errno) -> BoxliteError {
    let reason = match errno {
        Errno::ELOOP | Errno::ENOTDIR => "it is a link or not a folder".to_owned(),
        errno => errno.desc().to_owned(),
    };
    BoxliteError::Storage(format!(
        "cannot place the agent at {name:?} in the Box share: {reason}"
    ))
}

fn host_file_error(source: &Path, error: std::io::Error) -> BoxliteError {
    BoxliteError::InvalidArgument(format!(
        "cannot read agent binary {}: {error}",
        source.display()
    ))
}

/// Installed agents and their digests, in `<box>/agents.json`.
pub(super) struct InstallRecord {
    path: PathBuf,
}

impl InstallRecord {
    pub(super) fn new(box_dir: &Path) -> Self {
        Self {
            path: box_dir.join(RECORD_FILE),
        }
    }

    /// The recorded digest of `agent`. It names a folder in the Box and goes
    /// into a shell `PATH`, so anything but 64 lowercase hex digits is refused.
    pub(super) fn get(&self, agent: &str) -> BoxliteResult<Option<String>> {
        let Some(sha256) = self.read()?.remove(agent) else {
            return Ok(None);
        };
        let is_digest = sha256.len() == 64
            && sha256
                .bytes()
                .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'));
        if !is_digest {
            return Err(BoxliteError::Storage(format!(
                "agent record {} is corrupt: {agent} has no SHA-256 digest",
                self.path.display()
            )));
        }
        Ok(Some(sha256))
    }

    /// Record `agent` at `sha256`, replacing the file atomically.
    pub(super) fn insert(&self, agent: &str, sha256: &str) -> BoxliteResult<()> {
        let mut agents = self.read()?;
        agents.insert(agent.to_owned(), sha256.to_owned());
        let json = serde_json::to_vec(&agents)
            .map_err(|error| BoxliteError::Internal(format!("agent record: {error}")))?;
        let staging = self.path.with_extension("json.tmp");
        std::fs::write(&staging, json)
            .and_then(|()| std::fs::rename(&staging, &self.path))
            .map_err(|error| self.error(error))
    }

    fn read(&self) -> BoxliteResult<BTreeMap<String, String>> {
        match std::fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| {
                BoxliteError::Storage(format!(
                    "agent record {} is corrupt: {error}",
                    self.path.display()
                ))
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(error) => Err(self.error(error)),
        }
    }

    fn error(&self, error: std::io::Error) -> BoxliteError {
        BoxliteError::Storage(format!("agent record {}: {error}", self.path.display()))
    }
}

#[cfg(test)]
mod tests;
