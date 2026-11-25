use std::fs::File;
use std::io;
use std::mem::{size_of, zeroed};
use std::os::fd::{AsRawFd, FromRawFd, RawFd};
#[cfg(target_os = "linux")]
use std::os::unix::ffi::OsStrExt;
use std::os::unix::net::UnixStream;
#[cfg(target_os = "linux")]
use std::path::Path;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, ready};
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncWrite, Interest, ReadBuf};

#[cfg(target_os = "linux")]
fn remaining(end: Instant) -> io::Result<Duration> {
    end.checked_duration_since(Instant::now())
        .filter(|d| !d.is_zero())
        .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "VMM control deadline"))
}

/// A kernel socket timeout is the deadline, whichever loop the kernel interrupted.
#[cfg(target_os = "linux")]
fn timed_out(error: io::Error) -> io::Error {
    match error.kind() {
        io::ErrorKind::WouldBlock => {
            io::Error::new(io::ErrorKind::TimedOut, "VMM control deadline")
        }
        _ => error,
    }
}

#[cfg(target_os = "linux")]
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

// Set O_NONBLOCK as well as MSG_DONTWAIT: macOS does not reliably honor
// MSG_DONTWAIT alone. Tokio then owns the socket's readiness and deadlines.
pub(super) fn prepare_stream(stream: &UnixStream) -> io::Result<()> {
    stream.set_nonblocking(true)
}

// Configure the listener before accept. Darwin inherits the flag and can
// reject setsockopt on an accepted stream whose peer has already disconnected.
#[cfg(target_os = "macos")]
pub(super) fn suppress_sigpipe(socket: &impl AsRawFd) -> io::Result<()> {
    let one: libc::c_int = 1;
    // SAFETY: the caller owns a live socket and `one` stays live across the call.
    if unsafe {
        libc::setsockopt(
            socket.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_NOSIGPIPE,
            (&one as *const libc::c_int).cast(),
            size_of::<libc::c_int>() as libc::socklen_t,
        )
    } < 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn set_cloexec(fd: RawFd) -> io::Result<()> {
    // SAFETY: `fcntl(F_GETFD)` / `F_SETFD` operate on the open descriptor `fd`.
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags < 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

// cmsghdr alignment is required even when the byte capacity is sufficient.
#[repr(C)]
struct Ancillary {
    alignment: [libc::cmsghdr; 0],
    bytes: [u8; 64],
}

/// A connection can deliver one descriptor with its HTTP request.
#[derive(Clone, Default)]
pub(super) struct ReceivedFile(Arc<Mutex<Option<File>>>);

impl ReceivedFile {
    pub(super) fn take(&self) -> Option<File> {
        self.0.lock().expect("received file lock poisoned").take()
    }

    fn store(&self, file: File) {
        *self.0.lock().expect("received file lock poisoned") = Some(file);
    }
}

/// Preserves Unix ancillary data while Hyper reads and writes HTTP bytes.
pub(super) struct AncillaryIo {
    stream: tokio::net::UnixStream,
    outgoing: Option<File>,
    received: ReceivedFile,
    first_read: bool,
}

impl AncillaryIo {
    pub(super) fn new(
        stream: tokio::net::UnixStream,
        outgoing: Option<File>,
    ) -> (Self, ReceivedFile) {
        let received = ReceivedFile::default();
        (
            Self {
                stream,
                outgoing,
                received: received.clone(),
                first_read: true,
            },
            received,
        )
    }
}

impl AsyncRead for AncillaryIo {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if buffer.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        // recvmsg can return preceding bytes together with a later descriptor.
        // Isolating the first byte binds the descriptor to this HTTP exchange.
        let limit = if this.first_read {
            1
        } else {
            buffer.remaining()
        };
        loop {
            ready!(this.stream.poll_read_ready(cx))?;
            let result = this.stream.try_io(Interest::READABLE, || {
                receive_with_file(
                    this.stream.as_raw_fd(),
                    buffer.initialize_unfilled_to(limit),
                )
            });
            match result {
                Ok((count, file)) => {
                    if let Some(file) = file {
                        if !this.first_read {
                            return Poll::Ready(Err(invalid_ancillary()));
                        }
                        this.received.store(file);
                    }
                    this.first_read = false;
                    buffer.advance(count);
                    return Poll::Ready(Ok(()));
                }
                Err(error) if retry_io(&error) => continue,
                Err(error) => return Poll::Ready(Err(error)),
            }
        }
    }
}

impl AsyncWrite for AncillaryIo {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = self.get_mut();
        let Some(file) = &this.outgoing else {
            return Pin::new(&mut this.stream).poll_write(cx, bytes);
        };
        if bytes.is_empty() {
            return Poll::Ready(Ok(0));
        }
        loop {
            ready!(this.stream.poll_write_ready(cx))?;
            let result = this.stream.try_io(Interest::WRITABLE, || {
                send_with_file(this.stream.as_raw_fd(), bytes, file.as_raw_fd())
            });
            match result {
                Ok(0) => return Poll::Ready(Err(io::ErrorKind::WriteZero.into())),
                Ok(count) => {
                    // The kernel transfers the descriptor on the first positive write.
                    this.outgoing = None;
                    return Poll::Ready(Ok(count));
                }
                Err(error) if retry_io(&error) => continue,
                Err(error) => return Poll::Ready(Err(error)),
            }
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_flush(cx)
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().stream).poll_shutdown(cx)
    }
}

fn retry_io(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    )
}

pub(super) fn send_with_file(socket: RawFd, bytes: &[u8], file: RawFd) -> io::Result<usize> {
    let mut control = Ancillary {
        alignment: [],
        bytes: [0; 64],
    };
    let mut iov = libc::iovec {
        iov_base: bytes.as_ptr().cast_mut().cast(),
        iov_len: bytes.len(),
    };
    // SAFETY: a zeroed msghdr has no optional address pointers.
    let mut msg: libc::msghdr = unsafe { zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = control.bytes.as_mut_ptr().cast();
    // SAFETY: the aligned control buffer fits a header and a single descriptor.
    let sent = unsafe {
        msg.msg_controllen = libc::CMSG_SPACE(size_of::<RawFd>() as _) as _;
        let header = libc::CMSG_FIRSTHDR(&msg);
        (*header).cmsg_level = libc::SOL_SOCKET;
        (*header).cmsg_type = libc::SCM_RIGHTS;
        (*header).cmsg_len = libc::CMSG_LEN(size_of::<RawFd>() as _) as _;
        std::ptr::write_unaligned(libc::CMSG_DATA(header).cast::<RawFd>(), file);
        #[cfg(target_os = "linux")]
        let flags = libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL;
        #[cfg(not(target_os = "linux"))]
        let flags = libc::MSG_DONTWAIT;
        libc::sendmsg(socket, &msg, flags)
    };
    if sent < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(sent as usize)
}

fn receive_with_file(socket: RawFd, bytes: &mut [u8]) -> io::Result<(usize, Option<File>)> {
    let mut control = Ancillary {
        alignment: [],
        bytes: [0; 64],
    };
    let mut iov = libc::iovec {
        iov_base: bytes.as_mut_ptr().cast(),
        iov_len: bytes.len(),
    };
    // SAFETY: a zeroed msghdr has no optional address pointers.
    let mut msg: libc::msghdr = unsafe { zeroed() };
    msg.msg_iov = &mut iov;
    msg.msg_iovlen = 1;
    msg.msg_control = control.bytes.as_mut_ptr().cast();
    msg.msg_controllen = control.bytes.len() as _;
    #[cfg(target_os = "linux")]
    let flags = libc::MSG_DONTWAIT | libc::MSG_CMSG_CLOEXEC;
    #[cfg(not(target_os = "linux"))]
    let flags = libc::MSG_DONTWAIT;
    // SAFETY: the iovec and control buffer are live and writable for their declared lengths.
    let received = unsafe { libc::recvmsg(socket, &mut msg, flags) };
    if received < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut file = None;
    let mut invalid = msg.msg_flags & (libc::MSG_CTRUNC | libc::MSG_TRUNC) != 0;
    // SAFETY: recvmsg populated msg and its aligned control buffer.
    let (mut header, base) = unsafe { (libc::CMSG_FIRSTHDR(&msg), libc::CMSG_LEN(0) as usize) };
    while !header.is_null() {
        // SAFETY: this header was returned by the walk over the live buffer.
        let cmsg = unsafe { &*header };
        let length = cmsg.cmsg_len;
        #[cfg(any(not(target_os = "linux"), target_env = "musl"))]
        let length = length as usize;
        if length < base {
            invalid = true;
            break;
        }
        if cmsg.cmsg_level == libc::SOL_SOCKET && cmsg.cmsg_type == libc::SCM_RIGHTS {
            let count = (length - base) / size_of::<RawFd>();
            // SAFETY: the kernel initialized this header and its payload.
            let data = unsafe { libc::CMSG_DATA(header) }.cast::<RawFd>();
            for index in 0..count {
                // SAFETY: each full FD fits in the payload. Take ownership so
                // even descriptors from invalid messages are closed.
                let descriptor = unsafe { File::from_raw_fd(data.add(index).read_unaligned()) };
                #[cfg(not(target_os = "linux"))]
                if set_cloexec(descriptor.as_raw_fd()).is_err() {
                    invalid = true;
                    continue;
                }
                if file.is_some() {
                    invalid = true;
                } else {
                    file = Some(descriptor);
                }
            }
            invalid |= !(length - base).is_multiple_of(size_of::<RawFd>());
        } else {
            invalid = true;
        }
        // SAFETY: header belongs to msg's live, kernel-populated buffer.
        header = unsafe { libc::CMSG_NXTHDR(&msg, header) };
    }
    if invalid {
        return Err(invalid_ancillary());
    }
    Ok((received as usize, file))
}

fn invalid_ancillary() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "VMM control ancillary data")
}

#[cfg(any(
    test,
    all(
        target_os = "linux",
        target_arch = "x86_64",
        any(feature = "native", feature = "krun")
    ),
    all(feature = "krun", target_os = "macos", target_arch = "aarch64"),
))]
/// Whether the peer connected as `owner`, the uid this shim serves.
pub(super) fn same_user(stream: &UnixStream, owner: libc::uid_t) -> io::Result<bool> {
    #[cfg(target_os = "linux")]
    {
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

    #[cfg(not(target_os = "linux"))]
    {
        let mut uid: libc::uid_t = 0;
        let mut gid: libc::gid_t = 0;
        // SAFETY: `getpeereid` writes valid uid/gid for a connected Unix stream.
        if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(uid == owner)
    }
}
