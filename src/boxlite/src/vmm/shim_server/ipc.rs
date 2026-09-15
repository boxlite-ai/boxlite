//! Bounded private control frames with an optional SCM_RIGHTS descriptor.

use std::io::{self, IoSlice};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};

use nix::sys::socket::{ControlMessage, MsgFlags, sendmsg};
use serde::{Serialize, de::DeserializeOwned};
use tokio::io::{AsyncReadExt, AsyncWriteExt, Interest};
use tokio::net::UnixStream;

const MAX_FRAME_BYTES: usize = 1024 * 1024;

pub(super) struct ControlChannel(pub(super) UnixStream);

impl ControlChannel {
    pub(super) async fn send<T: Serialize>(
        &mut self,
        value: &T,
        descriptor: Option<&OwnedFd>,
    ) -> io::Result<()> {
        let body = serde_json::to_vec(value).map_err(|_| invalid("encode shim control frame"))?;
        if body.len() > MAX_FRAME_BYTES {
            return Err(invalid("shim control frame exceeds 1 MiB"));
        }
        let descriptors: Vec<_> = descriptor.iter().map(|fd| fd.as_raw_fd()).collect();
        self.send_descriptors(&descriptors).await?;
        self.0.write_u32(body.len() as u32).await?;
        self.0.write_all(&body).await
    }

    pub(super) async fn send_descriptors(&self, descriptors: &[RawFd]) -> io::Result<()> {
        let marker = [u8::from(!descriptors.is_empty())];
        loop {
            self.0.writable().await?;
            let result = self.0.try_io(Interest::WRITABLE, || {
                let ancillary = if descriptors.is_empty() {
                    vec![]
                } else {
                    vec![ControlMessage::ScmRights(descriptors)]
                };
                #[cfg(target_os = "linux")]
                let flags = MsgFlags::MSG_NOSIGNAL;
                #[cfg(not(target_os = "linux"))]
                let flags = MsgFlags::empty(); // Tokio sets SO_NOSIGPIPE on Darwin sockets.
                sendmsg::<()>(
                    self.0.as_raw_fd(),
                    &[IoSlice::new(&marker)],
                    &ancillary,
                    flags,
                    None,
                )
                .map_err(io::Error::from)
            });
            match result {
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
                Ok(1) => return Ok(()),
                Ok(_) => return Err(io::ErrorKind::WriteZero.into()),
                Err(error) => return Err(error),
            }
        }
    }

    pub(super) async fn receive<T: DeserializeOwned>(
        &mut self,
    ) -> io::Result<(T, Option<OwnedFd>)> {
        let descriptor = loop {
            self.0.readable().await?;
            match self.0.try_io(Interest::READABLE, || {
                receive_descriptor(self.0.as_raw_fd())
            }) {
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => continue,
                result => break result?,
            }
        };
        let length = self.0.read_u32().await? as usize;
        if length == 0 || length > MAX_FRAME_BYTES {
            return Err(invalid("invalid shim control frame length"));
        }
        let mut body = vec![0; length];
        self.0.read_exact(&mut body).await?;
        // Parser errors can contain credential bytes. Keep the diagnostic structural.
        let value =
            serde_json::from_slice(&body).map_err(|_| invalid("invalid shim control frame"))?;
        Ok((value, descriptor))
    }
}

fn receive_descriptor(socket: RawFd) -> io::Result<Option<OwnedFd>> {
    let mut marker = [0u8];
    let mut iov = libc::iovec {
        iov_base: marker.as_mut_ptr().cast(),
        iov_len: 1,
    };
    // Aligned and large enough for the kernel's maximum SCM_RIGHTS array.
    let mut ancillary = [0usize; 256];
    // SAFETY: zero is a valid initial msghdr; all pointers below reference live buffers.
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = ancillary.as_mut_ptr().cast();
    message.msg_controllen = std::mem::size_of_val(&ancillary) as _;
    #[cfg(target_os = "linux")]
    let flags = libc::MSG_CMSG_CLOEXEC;
    #[cfg(not(target_os = "linux"))]
    let flags = 0;
    // SAFETY: message points to writable, correctly sized buffers for this call.
    let received = unsafe { libc::recvmsg(socket, &mut message, flags) };
    if received < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut descriptors = Vec::new();
    let mut unknown = false;
    // Consume ownership even on malformed/truncated frames, so rejection cannot leak FDs.
    // SAFETY: CMSG traversal reads only the control buffer populated by the kernel.
    unsafe {
        let mut header = libc::CMSG_FIRSTHDR(&message);
        while !header.is_null() {
            if (*header).cmsg_level == libc::SOL_SOCKET && (*header).cmsg_type == libc::SCM_RIGHTS {
                let count = ((*header).cmsg_len as usize - libc::CMSG_LEN(0) as usize)
                    / std::mem::size_of::<RawFd>();
                let raw = libc::CMSG_DATA(header).cast::<RawFd>();
                for index in 0..count {
                    descriptors.push(OwnedFd::from_raw_fd(raw.add(index).read_unaligned()));
                }
            } else {
                unknown = true;
            }
            header = libc::CMSG_NXTHDR(&message, header);
        }
    }
    if received != 1
        || unknown
        || message.msg_flags & libc::MSG_CTRUNC != 0
        || marker[0] > 1
        || descriptors.len() != marker[0] as usize
    {
        return Err(invalid(
            "shim control requires exactly the declared zero or one descriptor",
        ));
    }
    for descriptor in &descriptors {
        // SAFETY: descriptor is owned and valid. CLOEXEC is set before any handoff.
        if unsafe { libc::fcntl(descriptor.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(descriptors.pop())
}

pub(super) fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
