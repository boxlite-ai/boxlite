use super::{
    ACK, ControlMount, MAX_FRAME, MOUNT_CONTROL_PREFACE, MountState, Request, Response, transport,
};
use boxlite_vmm::{AggregateFs, lookup_aggregate};
use std::fs::File;
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::path::{Component, Path};
use std::sync::{Arc, Mutex, Weak, mpsc::Receiver};

#[derive(Default)]
struct Registry {
    next: u64,
    filesystem: Option<Weak<AggregateFs>>,
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
    // Reserve a comma per record (one extra is harmless) and the longest state.
    Ok(counter.0 + 1 + usize::from(mount.state == MountState::Mounted) * 2)
}

fn normalize_target(target: &str) -> io::Result<String> {
    if target.len() > 4096 || target.contains('\0') || !target.starts_with('/') {
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
    fn live(&mut self, tag: &str) -> io::Result<Arc<AggregateFs>> {
        let live = lookup_aggregate(tag)?;
        if let Some(previous) = &self.filesystem {
            if !Weak::ptr_eq(previous, &Arc::downgrade(&live)) {
                return Err(errno(libc::ENODEV));
            }
        } else {
            self.filesystem = Some(Arc::downgrade(&live));
        }
        Ok(live)
    }

    fn request(
        &mut self,
        tag: &str,
        request: Request,
        mut files: Vec<File>,
    ) -> io::Result<Response> {
        let expected = usize::from(matches!(&request, Request::Register { .. }));
        if files.len() != expected {
            return Err(errno(libc::EINVAL));
        }
        let filesystem = self.live(tag)?;
        match request {
            Request::Register {
                source,
                target,
                read_only,
            } => {
                if source.is_empty() || source.len() > 4096 || source.contains('\0') {
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
                let envelope = b"{\"List\":[]}".len();
                if self.list_bytes + cost + envelope > MAX_FRAME {
                    return Err(errno(libc::ENOSPC));
                }
                // Reserve memory before publication so the remaining record insertion
                // cannot fail after register_fd has taken ownership.
                self.mounts
                    .try_reserve(1)
                    .map_err(|_| errno(libc::ENOMEM))?;
                self.next = next;
                filesystem.register_fd(mount.export.clone(), files.pop().unwrap(), read_only)?;
                // A replacement published during registration must never inherit this
                // server's records. Roll back only the export created in the old FS.
                if !Arc::ptr_eq(
                    &filesystem,
                    &lookup_aggregate(tag).inspect_err(|_| {
                        let _ = filesystem.remove(&mount.export);
                    })?,
                ) {
                    filesystem.remove(&mount.export)?;
                    return Err(errno(libc::ENODEV));
                }
                self.mounts.push(mount.clone());
                self.list_bytes += cost;
                Ok(Response::Registered(mount))
            }
            Request::List => Ok(Response::List(self.mounts.clone())),
            Request::SetState { export, state } => {
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
                Ok(Response::Ok)
            }
            Request::Remove { export } => {
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
                Ok(Response::Ok)
            }
        }
    }
}

fn same_user(stream: &UnixStream) -> io::Result<bool> {
    let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut length,
        )
    };
    if result < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(length as usize == std::mem::size_of::<libc::ucred>()
        && credentials.uid == unsafe { libc::geteuid() })
}

fn connection(stream: UnixStream, tag: &str, registry: &Mutex<Registry>) -> io::Result<()> {
    transport::configure(&stream)?;
    if !same_user(&stream)? {
        return Err(errno(libc::EPERM));
    }
    let end = transport::deadline();
    let mut preface = vec![0; MOUNT_CONTROL_PREFACE.len()];
    let mut files = Vec::new();
    transport::receive_exact(&stream, &mut preface, &mut files, end)?;
    if preface != MOUNT_CONTROL_PREFACE || !files.is_empty() {
        return Err(errno(libc::EPROTO));
    }
    transport::send_bytes(&stream, ACK, None, end)?;
    loop {
        let end = transport::deadline();
        let (payload, files) = transport::receive_frame(&stream, end)?;
        let request: Request = serde_json::from_slice(&payload)?;
        let response = match registry
            .lock()
            .map_err(|_| errno(libc::EIO))?
            .request(tag, request, files)
        {
            Ok(response) => response,
            Err(error) => Response::Error {
                errno: error.raw_os_error().unwrap_or(libc::EIO),
                context: format!("mount control: {error}"),
            },
        };
        transport::send_frame(&stream, &serde_json::to_vec(&response)?, None, end)?;
    }
}

/// Eight workers and an internal eight-stream queue bound handler resources.
/// The caller must also bound the incoming channel. Disconnecting that channel
/// closes active sockets and joins workers. Mutations never span client waits.
pub fn serve(connections: Receiver<UnixStream>, tag: String) {
    let (pending, receiver) = std::sync::mpsc::sync_channel::<UnixStream>(8);
    let receiver = Arc::new(Mutex::new(receiver));
    let registry = Arc::new(Mutex::new(Registry::default()));
    // Admission and shutdown share a lock; no worker can enter after closure.
    let active = Arc::new(Mutex::new((
        false,
        (0..8).map(|_| None::<UnixStream>).collect::<Vec<_>>(),
    )));
    let mut workers = Vec::new();
    for index in 0..8 {
        let receiver = Arc::clone(&receiver);
        let registry = Arc::clone(&registry);
        let active = Arc::clone(&active);
        let tag = tag.clone();
        workers.push(std::thread::spawn(move || {
            loop {
                let stream = match receiver.lock() {
                    Ok(receiver) => receiver.recv(),
                    Err(_) => return,
                };
                let Ok(stream) = stream else {
                    return;
                };
                {
                    let mut active = active.lock().unwrap();
                    if active.0 {
                        return;
                    }
                    match stream.try_clone() {
                        Ok(copy) => active.1[index] = Some(copy),
                        Err(_) => continue,
                    }
                }
                if let Err(error) = connection(stream, &tag, &registry) {
                    tracing::debug!(%error, "mount control connection closed");
                }
                active.lock().unwrap().1[index] = None;
            }
        }));
    }
    for stream in connections {
        let _ = pending.try_send(stream);
    }
    {
        let mut active = active.lock().unwrap();
        active.0 = true;
        for stream in active.1.iter().flatten() {
            let _ = stream.shutdown(std::net::Shutdown::Both);
        }
    }
    drop(pending);
    for worker in workers {
        let _ = worker.join();
    }
}

#[cfg(test)]
mod tests;
