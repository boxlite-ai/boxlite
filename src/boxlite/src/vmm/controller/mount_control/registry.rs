use super::{ControlMount, MountRequestId};
use crate::vmm::vmm_socket::{ControlOp, ControlReply, MAX_MOUNT_BODY};
use boxlite_shared::constants::normalize_target;
use boxlite_vmm::lookup_aggregate;
use std::fs::File;
use std::io;

/// Maximum length in bytes of a source or target path in a mount request.
const MAX_PATH_BYTES: usize = 4096;

/// The exports of one VM. Each names a directory descriptor the aggregate
/// device serves. Nothing here outlives the VM.
#[derive(Default)]
pub(crate) struct Registry {
    next: u64,
    mounts: Vec<RegisteredMount>,
    list_bytes: usize,
}

/// One registered export. The request that registered it lets a client whose
/// reply was lost find the export again.
struct RegisteredMount {
    mount: ControlMount,
    request_id: MountRequestId,
    /// The bytes the record takes in a `ListMounts` reply, JSON escaping included.
    cost: usize,
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
    // Reserve a comma per record (one extra is harmless).
    Ok(counter.0 + 1)
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
                request_id,
            } => {
                let directory = directory.ok_or_else(|| errno(libc::EINVAL))?;
                if source.is_empty() || source.len() > MAX_PATH_BYTES || source.contains('\0') {
                    return Err(errno(libc::EINVAL));
                }
                if target.len() > MAX_PATH_BYTES {
                    return Err(errno(libc::EINVAL));
                }
                let target = normalize_target(&target).ok_or_else(|| errno(libc::EINVAL))?;
                // One request registers one export: a retry must not publish a second.
                if self
                    .mounts
                    .iter()
                    .any(|entry| entry.request_id == request_id)
                {
                    return Err(errno(libc::EBUSY));
                }
                // One export per target: the guest would mount a second over the first.
                if self.mounts.iter().any(|entry| entry.mount.target == target) {
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
                };
                // Empty List envelope plus the serialized record.
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
                self.mounts.push(RegisteredMount {
                    mount: mount.clone(),
                    request_id,
                    cost,
                });
                self.list_bytes += cost;
                Ok(ControlReply::MountRegistered(mount))
            }
            ControlOp::ListMounts => Ok(ControlReply::Mounts(
                self.mounts
                    .iter()
                    .map(|entry| entry.mount.clone())
                    .collect(),
            )),
            ControlOp::FindRegisteredMount { request_id } => {
                let mount = self
                    .mounts
                    .iter()
                    .find(|entry| entry.request_id == request_id)
                    .map(|entry| entry.mount.clone());
                Ok(ControlReply::RegisteredMount(mount))
            }
            ControlOp::RemoveMount { export } => {
                // An export that is already gone stays gone, so a retry after a
                // lost reply finishes.
                let Some(index) = self
                    .mounts
                    .iter()
                    .position(|entry| entry.mount.export == export)
                else {
                    return Ok(ControlReply::MountUpdated);
                };
                filesystem.remove(&export)?;
                self.list_bytes -= self.mounts.remove(index).cost;
                Ok(ControlReply::MountUpdated)
            }
            ControlOp::ResizeDisk { .. } => unreachable!("disk resize is dispatched by the VMM"),
        }
    }
}
