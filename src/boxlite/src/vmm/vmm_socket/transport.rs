use super::MAX_FRAME;
use std::fs::File;
use std::io;
use std::mem::{size_of, zeroed};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, Instant};

fn remaining(end: Instant) -> io::Result<Duration> {
    end.checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "VMM control deadline"))
}

/// A kernel socket timeout is the deadline, whichever loop the kernel interrupted.
fn timed_out(error: io::Error) -> io::Error {
    match error.kind() {
        io::ErrorKind::WouldBlock => {
            io::Error::new(io::ErrorKind::TimedOut, "VMM control deadline")
        }
        _ => error,
    }
}

pub(super) fn connect(path: &Path, end: Instant) -> io::Result<UnixStream> {
    let bytes = path.as_os_str().as_bytes();
    // SAFETY: a zeroed address has a NUL-terminated pathname buffer.
    let mut address: libc::sockaddr_un = unsafe { zeroed() };
    if bytes.is_empty() || bytes.contains(&0) || bytes.len() >= address.sun_path.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "VMM control socket path",
        ));
    }
    address.sun_family = libc::AF_UNIX as _;
    for (destination, source) in address.sun_path.iter_mut().zip(bytes) {
        *destination = *source as libc::c_char;
    }
    let length =
        (std::mem::offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1) as libc::socklen_t;
    // SAFETY: socket has scalar arguments and returns a fresh fd on success.
    let fd = unsafe { libc::socket(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: this stream takes ownership of the fresh socket.
    let stream = unsafe { UnixStream::from_raw_fd(fd) };
    // Linux applies SO_SNDTIMEO to a blocking connect waiting on the listener backlog.
    stream.set_write_timeout(Some(remaining(end)?))?;
    // SAFETY: the initialized address covers `length` bytes, including the trailing NUL.
    if unsafe { libc::connect(fd, (&address as *const libc::sockaddr_un).cast(), length) } < 0 {
        return Err(timed_out(io::Error::last_os_error()));
    }
    Ok(stream)
}

// cmsghdr alignment is required even when the byte capacity is sufficient.
#[repr(C)]
struct Ancillary {
    alignment: [libc::cmsghdr; 0],
    bytes: [u8; 64],
}

pub(super) fn send_frame(
    stream: &UnixStream,
    payload: &[u8],
    fd: Option<RawFd>,
    end: Instant,
) -> io::Result<()> {
    if payload.len() > MAX_FRAME as usize {
        return Err(io::Error::from_raw_os_error(libc::EMSGSIZE));
    }
    send_parts(
        stream,
        &(payload.len() as u32).to_le_bytes(),
        payload,
        fd,
        end,
    )
}

pub(super) fn send_parts(
    stream: &UnixStream,
    head: &[u8],
    body: &[u8],
    mut fd: Option<RawFd>,
    end: Instant,
) -> io::Result<()> {
    let mut offset = 0;
    while offset < head.len() + body.len() {
        stream.set_write_timeout(Some(remaining(end)?))?;
        let mut control = Ancillary {
            alignment: [],
            bytes: [0; 64],
        };
        let (first, second) = if offset < head.len() {
            (&head[offset..], body)
        } else {
            (&body[offset - head.len()..], &[][..])
        };
        let mut iov = [
            libc::iovec {
                iov_base: first.as_ptr().cast_mut().cast(),
                iov_len: first.len(),
            },
            libc::iovec {
                iov_base: second.as_ptr().cast_mut().cast(),
                iov_len: second.len(),
            },
        ];
        // SAFETY: a zeroed msghdr has no optional address or ancillary pointers.
        let mut msg: libc::msghdr = unsafe { zeroed() };
        msg.msg_iov = iov.as_mut_ptr();
        msg.msg_iovlen = if second.is_empty() { 1 } else { 2 };
        if let Some(fd) = fd {
            msg.msg_control = control.bytes.as_mut_ptr().cast();
            msg.msg_controllen = unsafe { libc::CMSG_SPACE(size_of::<RawFd>() as _) } as _;
            unsafe {
                let header = libc::CMSG_FIRSTHDR(&msg);
                (*header).cmsg_level = libc::SOL_SOCKET;
                (*header).cmsg_type = libc::SCM_RIGHTS;
                (*header).cmsg_len = libc::CMSG_LEN(size_of::<RawFd>() as _) as _;
                std::ptr::write_unaligned(libc::CMSG_DATA(header).cast::<RawFd>(), fd);
            }
        }
        let sent = unsafe { libc::sendmsg(stream.as_raw_fd(), &msg, libc::MSG_NOSIGNAL) };
        if sent < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(timed_out(error));
        }
        if sent == 0 {
            return Err(io::Error::new(io::ErrorKind::WriteZero, "VMM control send"));
        }
        offset += sent as usize;
        // A positive send transferred ancillary ownership even on a short write.
        fd = None;
    }
    Ok(())
}

pub(super) fn receive_exact(
    stream: &UnixStream,
    bytes: &mut [u8],
    file: &mut Option<File>,
    end: Instant,
) -> io::Result<()> {
    let mut offset = 0;
    while offset < bytes.len() {
        stream.set_read_timeout(Some(remaining(end)?))?;
        let mut control = Ancillary {
            alignment: [],
            bytes: [0; 64],
        };
        let mut iov = libc::iovec {
            iov_base: bytes[offset..].as_mut_ptr().cast(),
            iov_len: bytes.len() - offset,
        };
        let mut msg: libc::msghdr = unsafe { zeroed() };
        msg.msg_iov = &mut iov;
        msg.msg_iovlen = 1;
        msg.msg_control = control.bytes.as_mut_ptr().cast();
        msg.msg_controllen = control.bytes.len() as _;
        let received =
            unsafe { libc::recvmsg(stream.as_raw_fd(), &mut msg, libc::MSG_CMSG_CLOEXEC) };
        if received < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(timed_out(error));
        }
        let mut invalid = false;
        unsafe {
            let mut header = libc::CMSG_FIRSTHDR(&msg);
            while !header.is_null() {
                let length = (*header).cmsg_len as usize;
                let base = libc::CMSG_LEN(0) as usize;
                if length < base {
                    invalid = true;
                    break;
                }
                if (*header).cmsg_level == libc::SOL_SOCKET
                    && (*header).cmsg_type == libc::SCM_RIGHTS
                {
                    let count = (length - base) / size_of::<RawFd>();
                    for index in 0..count {
                        let fd = std::ptr::read_unaligned(
                            libc::CMSG_DATA(header).cast::<RawFd>().add(index),
                        );
                        // Own each descriptor even when this frame will be rejected.
                        let received = File::from_raw_fd(fd);
                        if file.is_some() {
                            invalid = true;
                        } else {
                            *file = Some(received);
                        }
                    }
                    invalid |= !(length - base).is_multiple_of(size_of::<RawFd>());
                } else {
                    invalid = true;
                }
                header = libc::CMSG_NXTHDR(&msg, header);
            }
        }
        if invalid || msg.msg_flags & (libc::MSG_CTRUNC | libc::MSG_TRUNC) != 0 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "VMM control ancillary data",
            ));
        }
        if received == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "VMM control frame",
            ));
        }
        offset += received as usize;
    }
    Ok(())
}

pub(super) fn receive_frame(
    stream: &UnixStream,
    end: Instant,
) -> io::Result<(Vec<u8>, Option<File>)> {
    let mut file = None;
    let mut header = [0; 4];
    receive_exact(stream, &mut header, &mut file, end)?;
    let length = u32::from_le_bytes(header);
    if length > MAX_FRAME {
        return Err(io::Error::from_raw_os_error(libc::EMSGSIZE));
    }
    let mut payload = vec![0; length as usize];
    receive_exact(stream, &mut payload, &mut file, end)?;
    Ok((payload, file))
}

/// Whether the peer connected as `owner`, the uid this shim serves.
pub(super) fn same_user(stream: &UnixStream, owner: libc::uid_t) -> io::Result<bool> {
    // SAFETY: ucred is initialized before getsockopt writes to it.
    let mut credentials: libc::ucred = unsafe { zeroed() };
    let mut length = size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: credentials and length are writable for the supplied size.
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
    Ok(length as usize == size_of::<libc::ucred>() && credentials.uid == owner)
}
