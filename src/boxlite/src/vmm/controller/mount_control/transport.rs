use super::MAX_FRAME;
use std::fs::File;
use std::io;
use std::mem::{size_of, zeroed};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::{Duration, Instant};

pub(super) fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(5)
}

pub(super) fn configure(stream: &UnixStream) -> io::Result<()> {
    // Routed sockets arrive nonblocking; framing uses deadline-bound blocking I/O.
    stream.set_nonblocking(false)?;
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    unsafe {
        let enabled: libc::c_int = 1;
        if libc::setsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_NOSIGPIPE,
            (&enabled as *const libc::c_int).cast(),
            size_of::<libc::c_int>() as _,
        ) < 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))
}

fn remaining(end: Instant) -> io::Result<Duration> {
    end.checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "mount control frame deadline"))
}

pub(super) fn connect(path: &Path, end: Instant) -> io::Result<UnixStream> {
    // Reserve the trailing NUL; abstract namespace sockets are not control paths.
    let bytes = path.as_os_str().as_bytes();
    let mut address: libc::sockaddr_un = unsafe { zeroed() };
    if bytes.is_empty() || bytes.contains(&0) || bytes.len() >= address.sun_path.len() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "mount control socket path",
        ));
    }
    address.sun_family = libc::AF_UNIX as _;
    for (destination, source) in address.sun_path.iter_mut().zip(bytes) {
        *destination = *source as libc::c_char;
    }
    let length =
        (std::mem::offset_of!(libc::sockaddr_un, sun_path) + bytes.len() + 1) as libc::socklen_t;
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        address.sun_len = length as u8;
    }
    #[cfg(target_os = "linux")]
    let flags = libc::SOCK_STREAM | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK;
    #[cfg(not(target_os = "linux"))]
    let flags = libc::SOCK_STREAM;
    let stream = loop {
        remaining(end)?;
        let fd = unsafe { libc::socket(libc::AF_UNIX, flags, 0) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        // Own the descriptor before any fallible operation.
        let stream = unsafe { UnixStream::from_raw_fd(fd) };
        #[cfg(not(target_os = "linux"))]
        {
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
            if flags < 0 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0
            {
                return Err(io::Error::last_os_error());
            }
            stream.set_nonblocking(true)?;
        }
        let result =
            unsafe { libc::connect(fd, (&address as *const libc::sockaddr_un).cast(), length) };
        if result == 0 {
            remaining(end)?;
            return Ok(stream);
        }
        let error = io::Error::last_os_error();
        match error.raw_os_error() {
            // AF_UNIX backlog saturation need not initiate a connection. Its
            // writable status cannot establish completion. Close failed sockets
            // before retrying: their state is unspecified across platforms.
            Some(libc::EAGAIN) => {
                drop(stream);
                std::thread::sleep(remaining(end)?.min(Duration::from_millis(50)));
            }
            Some(libc::EINPROGRESS) | Some(libc::EINTR) => break stream,
            _ => return Err(error),
        }
    };
    let fd = stream.as_raw_fd();
    loop {
        let timeout = remaining(end)?
            .as_millis()
            .saturating_add(1)
            .min(i32::MAX as u128) as i32;
        let mut poll = libc::pollfd {
            fd,
            events: libc::POLLOUT,
            revents: 0,
        };
        let result = unsafe { libc::poll(&mut poll, 1, timeout) };
        if result < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        remaining(end)?;
        if result == 0 {
            continue;
        }
        if let Some(error) = stream.take_error()? {
            return Err(error);
        }
        // SO_ERROR is meaningful only after readiness of a pending connection.
        if poll.revents & libc::POLLNVAL != 0 {
            return Err(io::Error::from_raw_os_error(libc::EBADF));
        }
        return Ok(stream);
    }
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
    if payload.len() > MAX_FRAME {
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

pub(super) fn send_bytes(
    stream: &UnixStream,
    bytes: &[u8],
    fd: Option<RawFd>,
    end: Instant,
) -> io::Result<()> {
    send_parts(stream, bytes, &[], fd, end)
}

fn send_parts(
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
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        let flags = 0;
        #[cfg(not(any(target_os = "macos", target_os = "ios")))]
        let flags = libc::MSG_NOSIGNAL;
        let sent = unsafe { libc::sendmsg(stream.as_raw_fd(), &msg, flags) };
        if sent < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        if sent == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "mount control send",
            ));
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
    files: &mut Vec<File>,
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
        #[cfg(target_os = "linux")]
        let flags = libc::MSG_CMSG_CLOEXEC;
        #[cfg(not(target_os = "linux"))]
        let flags = 0;
        let received = unsafe { libc::recvmsg(stream.as_raw_fd(), &mut msg, flags) };
        if received < 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        let mut invalid = false;
        #[cfg(not(target_os = "linux"))]
        let first_new = files.len();
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
                        files.push(File::from_raw_fd(fd));
                    }
                    invalid |= !(length - base).is_multiple_of(size_of::<RawFd>());
                } else {
                    invalid = true;
                }
                header = libc::CMSG_NXTHDR(&msg, header);
            }
        }
        // Own every delivered FD before checking truncation or descriptor flags.
        #[cfg(not(target_os = "linux"))]
        for file in &files[first_new..] {
            let old = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFD) };
            if old < 0
                || unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFD, old | libc::FD_CLOEXEC) }
                    < 0
            {
                return Err(io::Error::last_os_error());
            }
        }
        if invalid || msg.msg_flags & (libc::MSG_CTRUNC | libc::MSG_TRUNC) != 0 || files.len() > 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "mount control ancillary data",
            ));
        }
        if received == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "mount control frame",
            ));
        }
        offset += received as usize;
    }
    Ok(())
}

pub(super) fn receive_frame(stream: &UnixStream, end: Instant) -> io::Result<(Vec<u8>, Vec<File>)> {
    let mut files = Vec::new();
    let mut header = [0; 4];
    receive_exact(stream, &mut header, &mut files, end)?;
    let length = u32::from_le_bytes(header) as usize;
    if length == 0 || length > MAX_FRAME {
        return Err(io::Error::from_raw_os_error(libc::EMSGSIZE));
    }
    let mut payload = vec![0; length];
    receive_exact(stream, &mut payload, &mut files, end)?;
    Ok((payload, files))
}
