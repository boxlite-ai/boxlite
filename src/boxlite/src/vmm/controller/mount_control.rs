//! Mount-control socket: the runtime→shim channel for runtime directory
//! delivery.
//!
//! Frames are `u32`-LE length-prefixed JSON. A `Register` request carries
//! exactly one directory descriptor via `SCM_RIGHTS` attached to the same
//! send; every other request must carry none, and any descriptor that fails
//! validation is closed before the error reply leaves the server. The socket
//! lives in the Box directory (both sides derive the path from the layout,
//! never across a trust boundary) and answers only peers of the owning user
//! (`SO_PEERCRED`), so delivery stays between the runtime and the isolated
//! shim. The server is synchronous and single-threaded per connection: the
//! control plane is low-volume and the filesystem performs its own locking.

use std::fs::File;
use std::io::{self, ErrorKind, Read, Write};
use std::mem::size_of;
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;

use serde::{Deserialize, Serialize};

use boxlite_shared::constants::mount_tags::MOUNT_CONTROL_SOCKET;

#[cfg(feature = "native")]
use std::sync::Arc;

#[cfg(feature = "native")]
use boxlite_vmm::AggregateFs;

/// Largest accepted frame payload. Requests carry only names and flags.
const MAX_FRAME: u32 = 64 * 1024;

#[derive(Debug, Serialize, Deserialize)]
pub enum MountRequest {
    /// Publish a delivered directory beneath `name`. Requires exactly one
    /// attached descriptor.
    Register { name: String, read_only: bool },
    /// Retire the export published under `name`.
    Remove { name: String },
}

#[derive(Debug, Serialize, Deserialize)]
pub enum MountResponse {
    Registered { root: u64 },
    Removed,
    Error { code: i32, message: String },
}

impl MountResponse {
    fn from_error(error: &io::Error) -> Self {
        MountResponse::Error {
            code: error.raw_os_error().unwrap_or(libc::EIO),
            message: error.to_string(),
        }
    }
}

/// The control socket path inside the Box `sockets` directory.
pub fn mount_control_socket(sockets_dir: &Path) -> std::path::PathBuf {
    sockets_dir.join(MOUNT_CONTROL_SOCKET)
}

// ============================================================================
// Frame transport with descriptor passing
// ============================================================================

fn frame_bytes(payload: &[u8]) -> [u8; 4] {
    (payload.len() as u32).to_le_bytes()
}

/// Sends one length-prefixed frame, optionally passing one descriptor along
/// in the same send. The descriptor is not consumed on send failure: the
/// caller keeps ownership so it can close or reuse it.
fn send_frame(stream: &UnixStream, payload: &[u8], fd: Option<RawFd>) -> io::Result<()> {
    let head = frame_bytes(payload);
    let iov = [
        libc::iovec {
            iov_base: head.as_ptr().cast::<libc::c_void>().cast_mut(),
            iov_len: head.len() as libc::size_t,
        },
        libc::iovec {
            iov_base: payload.as_ptr().cast::<libc::c_void>().cast_mut(),
            iov_len: payload.len() as libc::size_t,
        },
    ];
    // One cmsg with space for one descriptor. Runtime allocation sidesteps
    // the arch-dependent CMSG_SPACE constant in a const array length.
    let mut control = vec![0u8; unsafe { libc::CMSG_SPACE(size_of::<RawFd>() as u32) } as usize];
    let message = libc::msghdr {
        msg_name: std::ptr::null_mut(),
        msg_namelen: 0,
        msg_iov: iov.as_ptr().cast_mut(),
        msg_iovlen: iov.len() as _,
        msg_control: if fd.is_some() {
            control.as_mut_ptr().cast()
        } else {
            std::ptr::null_mut()
        },
        msg_controllen: if fd.is_some() { control.len() as _ } else { 0 },
        msg_flags: 0,
    };
    if let Some(fd) = fd {
        // SAFETY: the control buffer was sized with CMSG_SPACE for one header.
        let header = unsafe { libc::CMSG_FIRSTHDR(&message) };
        unsafe {
            (*header).cmsg_level = libc::SOL_SOCKET;
            (*header).cmsg_type = libc::SCM_RIGHTS;
            (*header).cmsg_len = libc::CMSG_LEN(size_of::<RawFd>() as u32) as _;
            libc::CMSG_DATA(header).cast::<RawFd>().write_unaligned(fd);
        }
    }
    // SAFETY: the message header and both buffers remain valid for the call.
    let sent = unsafe { libc::sendmsg(stream.as_raw_fd(), &message, 0) };
    if sent < 0 {
        return Err(io::Error::last_os_error());
    }
    if sent as usize != head.len() + payload.len() {
        // Control frames are tiny; a short send would corrupt the framing.
        return Err(io::Error::from_raw_os_error(libc::EIO));
    }
    Ok(())
}

/// Receives one length-prefixed frame and any descriptor attached to it.
/// Returns `Ok(None)` for a clean EOF at a frame boundary. Framing errors
/// and descriptor attachment never coexist: a received descriptor is closed
/// before the error returns.
fn receive_frame(stream: &mut UnixStream) -> io::Result<Option<(Vec<u8>, Option<File>)>> {
    let mut len = [0u8; 4];
    let mut control = vec![0u8; unsafe { libc::CMSG_SPACE(size_of::<RawFd>() as u32) } as usize];
    let iov = [libc::iovec {
        iov_base: len.as_mut_ptr().cast::<libc::c_void>(),
        iov_len: len.len() as libc::size_t,
    }];
    // recvmsg legitimately mutates this header (msg_flags, controllen).
    let mut message = libc::msghdr {
        msg_name: std::ptr::null_mut(),
        msg_namelen: 0,
        msg_iov: iov.as_ptr().cast_mut(),
        msg_iovlen: iov.len() as _,
        msg_control: control.as_mut_ptr().cast(),
        msg_controllen: control.len() as _,
        msg_flags: 0,
    };
    // SAFETY: header, buffers and the control buffer remain valid; the kernel
    // marks received descriptors close-on-exec with MSG_CMSG_CLOEXEC.
    let received =
        unsafe { libc::recvmsg(stream.as_raw_fd(), &mut message, libc::MSG_CMSG_CLOEXEC) };
    if received < 0 {
        return Err(io::Error::last_os_error());
    }
    if received == 0 {
        return Ok(None);
    }
    if message.msg_flags & libc::MSG_CTRUNC != 0 {
        // The peer tried to pass more than this protocol accepts. Reject the
        // connection rather than guessing at the remaining bytes.
        return Err(io::Error::from_raw_os_error(libc::EPROTO));
    }
    let mut attached = None;
    // SAFETY: the header was produced by recvmsg into our control buffer;
    // CMSG_NEXT stops at the null-terminated header chain.
    unsafe {
        let mut header = libc::CMSG_FIRSTHDR(&message);
        while !header.is_null() {
            let current = &mut *header;
            if current.cmsg_level == libc::SOL_SOCKET && current.cmsg_type == libc::SCM_RIGHTS {
                let data = libc::CMSG_DATA(current).cast::<RawFd>();
                let count =
                    (current.cmsg_len as usize - libc::CMSG_LEN(0) as usize) / size_of::<RawFd>();
                // Only the first descriptor belongs to this protocol level;
                // extras indicate a peer protocol violation and are closed.
                for extra in 1..count {
                    libc::close(*data.add(extra));
                }
                if count >= 1 {
                    attached = Some(File::from_raw_fd(*data));
                }
            }
            header = libc::CMSG_NXTHDR(&message, header);
        }
    }
    let fail = |attached: Option<File>, code: i32| {
        drop(attached);
        Err(io::Error::from_raw_os_error(code))
    };
    if received as usize != len.len() {
        // A frame boundary this protocol cannot recover from: the peer is
        // not speaking the framing.
        return fail(attached, libc::EPROTO);
    }
    let length = u32::from_le_bytes(len);
    if length == 0 || length > MAX_FRAME {
        return fail(attached, libc::EPROTO);
    }
    let mut payload = vec![0u8; length as usize];
    if stream.read_exact(&mut payload).is_err() {
        return fail(attached, libc::EIO);
    }
    Ok(Some((payload, attached)))
}

// ============================================================================
// Server (requires the native VMM: the filesystem handle lives in its device)
// ============================================================================

#[cfg(feature = "native")]
fn same_user(stream: &UnixStream) -> bool {
    let mut credential = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut length = size_of::<libc::ucred>() as u32;
    // SAFETY: the output buffer and its length describe the credential record.
    let ok = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credential as *mut libc::ucred).cast(),
            &mut length,
        )
    };
    ok == 0 && credential.uid == unsafe { libc::geteuid() }
}

#[cfg(feature = "native")]
fn handle_request(
    filesystem: &Arc<AggregateFs>,
    request: MountRequest,
    descriptor: Option<File>,
) -> MountResponse {
    match (request, descriptor) {
        (MountRequest::Register { name, read_only }, Some(file)) => filesystem
            .register_fd(name, file, read_only)
            .map(|root| MountResponse::Registered { root })
            .unwrap_or_else(|error| MountResponse::from_error(&error)),
        (MountRequest::Register { .. }, None) => MountResponse::Error {
            code: libc::EINVAL,
            message: "Register requires exactly one directory descriptor".into(),
        },
        (MountRequest::Remove { name }, None) => filesystem
            .remove(&name)
            .map(|()| MountResponse::Removed)
            .unwrap_or_else(|error| MountResponse::from_error(&error)),
        (MountRequest::Remove { .. }, Some(file)) => {
            drop(file);
            MountResponse::Error {
                code: libc::EINVAL,
                message: "Remove must not carry a descriptor".into(),
            }
        }
    }
}

#[cfg(feature = "native")]
fn serve_connection(stream: &mut UnixStream, tag: &str) {
    loop {
        let (payload, descriptor) = match receive_frame(stream) {
            Ok(Some(frame)) => frame,
            Ok(None) => return,
            Err(error) if error.kind() == ErrorKind::UnexpectedEof => return,
            Err(_) => return,
        };
        let filesystem = match boxlite_vmm::lookup_aggregate(tag) {
            Ok(filesystem) => filesystem,
            Err(error) => {
                drop(descriptor);
                let response = MountResponse::from_error(&error);
                if write_response(stream, response).is_err() {
                    return;
                }
                continue;
            }
        };
        let response = match serde_json::from_slice::<MountRequest>(&payload) {
            Ok(request) => handle_request(&filesystem, request, descriptor),
            Err(error) => {
                drop(descriptor);
                MountResponse::Error {
                    code: libc::EBADMSG,
                    message: error.to_string(),
                }
            }
        };
        if write_response(stream, response).is_err() {
            return;
        }
    }
}

fn write_response(stream: &mut UnixStream, response: MountResponse) -> io::Result<()> {
    let payload = serde_json::to_vec(&response)?;
    let bytes = frame_bytes(&payload);
    stream.write_all(&bytes)?;
    stream.write_all(&payload)?;
    stream.flush()
}

/// Accepts mount-control connections until the process exits. Each accepted
/// connection is verified as the owning user and then served serially; a
/// misbehaving peer only costs its own connection.
#[cfg(feature = "native")]
pub fn serve(listener: UnixListener, tag: String) {
    // Clients hold persistent connections; each gets its own thread so one
    // idle client cannot queue out the next one.
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        if !same_user(&stream) {
            continue;
        }
        let tag = tag.clone();
        std::thread::spawn(move || {
            let mut stream = stream;
            serve_connection(&mut stream, &tag);
        });
    }
}

/// Binds the Box-directory control socket with owner-only permissions.
/// Returns the listener; the caller serves it on its own thread.
pub fn bind(box_dir: &Path) -> io::Result<UnixListener> {
    use std::os::unix::fs::PermissionsExt;
    let path = mount_control_socket(box_dir);
    // A previous shim on this Box directory leaves the socket behind.
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path)?;
    // fchmod on the listener sets the socket inode mode; the path-based chmod
    // is outside the shim seccomp profile.
    let mut mode = std::fs::metadata(&path)?.permissions();
    mode.set_mode(0o600);
    // SAFETY: the descriptor and mode value remain valid for the call.
    let mode_value = mode.mode();
    if unsafe { libc::fchmod(listener.as_raw_fd(), mode_value) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(listener)
}

// ============================================================================
// Client
// ============================================================================

/// Blocking client for the runtime side. The async runtime wraps these calls
/// in `spawn_blocking`; the control plane never blocks long enough to matter.
pub struct MountControlClient {
    stream: UnixStream,
}

impl MountControlClient {
    pub fn connect(box_dir: &Path) -> io::Result<Self> {
        let stream = UnixStream::connect(mount_control_socket(box_dir))?;
        Ok(Self { stream })
    }

    pub fn register(
        &mut self,
        name: String,
        file: File,
        read_only: bool,
    ) -> io::Result<MountResponse> {
        let request = MountRequest::Register { name, read_only };
        self.call(&request, Some(file.as_raw_fd()))
    }

    pub fn remove(&mut self, name: &str) -> io::Result<MountResponse> {
        let request = MountRequest::Remove {
            name: name.to_string(),
        };
        self.call(&request, None)
    }

    fn call(&mut self, request: &MountRequest, fd: Option<RawFd>) -> io::Result<MountResponse> {
        let payload = serde_json::to_vec(request)?;
        send_frame(&self.stream, &payload, fd)?;
        let mut length = [0u8; 4];
        self.stream.read_exact(&mut length)?;
        let length = u32::from_le_bytes(length);
        if length == 0 || length > MAX_FRAME {
            return Err(io::Error::from_raw_os_error(libc::EPROTO));
        }
        let mut payload = vec![0u8; length as usize];
        self.stream.read_exact(&mut payload)?;
        serde_json::from_slice(&payload)
            .map_err(|error| io::Error::new(ErrorKind::InvalidData, error))
    }
}

#[cfg(test)]
mod tests;
