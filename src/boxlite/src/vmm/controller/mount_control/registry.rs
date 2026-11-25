use super::{ControlMount, MountState};
use crate::vmm::vmm_socket::{ControlOp, ControlReply, MAX_MOUNT_BODY};
use boxlite_vmm::lookup_aggregate;
use std::fs::File;
use std::io;
use std::path::{Component, Path};

/// Maximum length in bytes of a source or target path in a mount request.
const MAX_PATH_BYTES: usize = 4096;

#[derive(Default)]
pub(crate) struct Registry {
    next: u64,
    mounts: Vec<ControlMount>,
    list_bytes: usize,
}

fn errno(code: i32) -> io::Error {
    io::Error::from_raw_os_error(code)
}

fn record_cost(mount: &ControlMount) -> io::Result<usize> {
    struct Counter(usize);
    impl io::Write for Counter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.0 += bytes.len();
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut counter = Counter(0);
    serde_json::to_writer(&mut counter, mount)?;
    // Reserve a comma per record (one extra is harmless). `Preparing` is as
    // long as the record ever serializes: `Detaching` matches it, `Mounted` is shorter.
    Ok(counter.0 + 1)
}

fn normalize_target(target: &str) -> io::Result<String> {
    if target.len() > MAX_PATH_BYTES || target.contains('\0') || !target.starts_with('/') {
        return Err(errno(libc::EINVAL));
    }
    let mut components = Vec::new();
    for component in Path::new(target).components() {
        match component {
            Component::RootDir | Component::CurDir => (),
            Component::Normal(name) => {
                components.push(name.to_str().ok_or_else(|| errno(libc::EINVAL))?)
            }
            _ => return Err(errno(libc::EINVAL)),
        }
    }
    if components.is_empty() {
        return Err(errno(libc::EINVAL));
    }
    Ok(format!("/{}", components.join("/")))
}

impl Registry {
    pub(crate) fn request(
        &mut self,
        tag: &str,
        request: ControlOp,
        directory: Option<File>,
    ) -> io::Result<ControlReply> {
        let filesystem = lookup_aggregate(tag)?;
        match request {
            ControlOp::RegisterMount {
                source,
                target,
                read_only,
            } => {
                let directory = directory.ok_or_else(|| errno(libc::EINVAL))?;
                if source.is_empty() || source.len() > MAX_PATH_BYTES || source.contains('\0') {
                    return Err(errno(libc::EINVAL));
                }
                let target = normalize_target(&target)?;
                if self.mounts.iter().any(|mount| mount.target == target) {
                    return Err(errno(libc::EBUSY));
                }
                let next = self
                    .next
                    .checked_add(1)
                    .ok_or_else(|| errno(libc::EOVERFLOW))?;
                let mount = ControlMount {
                    export: format!("mount-{next}"),
                    source,
                    target,
                    read_only,
                    state: MountState::Preparing,
                };
                // Empty List envelope plus worst-case serialized records; the
                // counter includes JSON escaping without copying existing records.
                let cost = record_cost(&mount)?;
                let envelope = br#"{"Ok":{"mounts":[]}}"#.len();
                if self.list_bytes + cost + envelope > MAX_MOUNT_BODY {
                    return Err(errno(libc::ENOSPC));
                }
                // Reserve memory before publication so the remaining record insertion
                // cannot fail after register_fd has taken ownership.
                self.mounts
                    .try_reserve(1)
                    .map_err(|_| errno(libc::ENOMEM))?;
                self.next = next;
                filesystem.register_fd(mount.export.clone(), directory, read_only)?;
                self.mounts.push(mount.clone());
                self.list_bytes += cost;
                Ok(ControlReply::MountRegistered(mount))
            }
            ControlOp::ListMounts => Ok(ControlReply::Mounts(self.mounts.clone())),
            ControlOp::SetMountState { export, state } => {
                let mount = self
                    .mounts
                    .iter_mut()
                    .find(|mount| mount.export == export)
                    .ok_or_else(|| errno(libc::ENOENT))?;
                match (mount.state, state) {
                    (current, requested) if current == requested => (),
                    (MountState::Preparing, MountState::Mounted | MountState::Detaching)
                    | (MountState::Mounted, MountState::Detaching) => mount.state = state,
                    _ => return Err(errno(libc::EINVAL)),
                }
                Ok(ControlReply::MountUpdated)
            }
            ControlOp::RemoveMount { export } => {
                let index = self
                    .mounts
                    .iter()
                    .position(|mount| mount.export == export)
                    .ok_or_else(|| errno(libc::ENOENT))?;
                if self.mounts[index].state != MountState::Detaching {
                    return Err(errno(libc::EBUSY));
                }
                let cost = record_cost(&self.mounts[index])?;
                filesystem.remove(&export)?;
                self.mounts.remove(index);
                self.list_bytes -= cost;
                Ok(ControlReply::MountUpdated)
            }
            ControlOp::ResizeDisk { .. } => unreachable!("disk resize is dispatched by the VMM"),
            ControlOp::CaptureCheckpoint { .. } => Err(errno(libc::EOPNOTSUPP)),
        }
    }
}
