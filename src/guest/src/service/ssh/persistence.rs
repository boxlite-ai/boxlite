//! Durable desired SSH state, confined to the container root filesystem.

use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use nix::fcntl::{openat2, OFlag, OpenHow, ResolveFlag};
use nix::sys::stat::{fchmod, mkdirat, Mode};
use nix::unistd::{fchown, Gid, Uid};
use serde::{Deserialize, Serialize};

const MAX_CONFIG_BYTES: u64 = 4 * 1024 * 1024;
const CONFINED: ResolveFlag = ResolveFlag::RESOLVE_BENEATH
    .union(ResolveFlag::RESOLVE_NO_SYMLINKS)
    .union(ResolveFlag::RESOLVE_NO_MAGICLINKS)
    .union(ResolveFlag::RESOLVE_NO_XDEV);

#[cfg(test)]
#[path = "tests/persistence.rs"]
mod tests;
#[cfg(test)]
use tests::pause_save;
#[cfg(test)]
pub(super) use tests::{SaveGate, SAVE_GATE};

#[derive(Default, Serialize, Deserialize)]
pub(super) struct DesiredState {
    pub enable: bool,
    pub config: Option<boxlite_shared::SshConfig>,
}

fn error() -> io::Error {
    io::Error::other("SSH state storage failed")
}

fn open_dir(parent: &File, name: &str, create: bool, mode: u32) -> io::Result<Option<File>> {
    let how = OpenHow::new()
        .flags(OFlag::O_RDONLY | OFlag::O_DIRECTORY | OFlag::O_CLOEXEC)
        .resolve(CONFINED);
    let open = || openat2(parent.as_raw_fd(), name, how);
    let fd = match open() {
        Ok(fd) => fd,
        Err(nix::errno::Errno::ENOENT) if !create => return Ok(None),
        Err(nix::errno::Errno::ENOENT) => {
            mkdirat(
                Some(parent.as_raw_fd()),
                name,
                Mode::from_bits_truncate(mode),
            )?;
            parent.sync_all()?;
            open()?
        }
        Err(err) => return Err(err.into()),
    };
    // SAFETY: openat2 returns a newly owned descriptor.
    let file = unsafe { File::from_raw_fd(fd) };
    let meta = file.metadata()?;
    if meta.uid() != 0 || meta.mode() & 0o022 != 0 || (mode == 0o700 && meta.mode() & 0o077 != 0) {
        return Err(error());
    }
    Ok(Some(file))
}

fn directory(root: &Path, create: bool) -> io::Result<Option<File>> {
    let root = File::open(root)?;
    let Some(etc) = open_dir(&root, "etc", create, 0o755)? else {
        return Ok(None);
    };
    open_dir(&etc, "boxlite", create, 0o700)
}

pub(super) fn load(root: &Path) -> io::Result<DesiredState> {
    let Some(dir) = directory(root, false)? else {
        return Ok(DesiredState::default());
    };
    let how = OpenHow::new()
        .flags(OFlag::O_RDONLY | OFlag::O_NONBLOCK | OFlag::O_CLOEXEC | OFlag::O_NOFOLLOW)
        .resolve(CONFINED);
    let fd = match openat2(dir.as_raw_fd(), "ssh.cfg", how) {
        Ok(fd) => fd,
        Err(nix::errno::Errno::ENOENT) => return Ok(DesiredState::default()),
        Err(err) => return Err(err.into()),
    };
    // SAFETY: openat2 returns a newly owned descriptor.
    let file = unsafe { File::from_raw_fd(fd) };
    let meta = file.metadata()?;
    if !meta.is_file()
        || meta.uid() != 0
        || meta.mode() & 0o077 != 0
        || meta.nlink() != 1
        || meta.len() > MAX_CONFIG_BYTES
    {
        return Err(error());
    }
    let mut bytes = Vec::new();
    file.take(MAX_CONFIG_BYTES + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(error());
    }
    serde_json::from_slice(&bytes).map_err(|_| error())
}

pub(super) fn save(root: &Path, state: &DesiredState) -> io::Result<()> {
    let bytes = serde_json::to_vec(state).map_err(|_| error())?;
    if bytes.len() as u64 > MAX_CONFIG_BYTES {
        return Err(error());
    }
    let dir = directory(root, true)?.ok_or_else(error)?;
    // The live descriptor pins the verified private directory for both paths.
    let pinned_dir = format!("/proc/self/fd/{}", dir.as_raw_fd());
    let mut file = tempfile::NamedTempFile::new_in(&pinned_dir)?;
    fchown(
        file.as_raw_fd(),
        Some(Uid::from_raw(0)),
        Some(Gid::from_raw(0)),
    )?;
    fchmod(file.as_raw_fd(), Mode::from_bits_truncate(0o600))?;
    file.write_all(&bytes)?;
    file.as_file().sync_all()?;
    #[cfg(test)]
    pause_save(false)?;
    file.persist(Path::new(&pinned_dir).join("ssh.cfg"))
        .map_err(|err| err.error)?;
    #[cfg(test)]
    pause_save(true)?;
    dir.sync_all()
}
