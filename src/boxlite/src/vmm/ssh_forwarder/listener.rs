use std::io;
use std::os::fd::OwnedFd;

use nix::sys::socket::{SockType, SockaddrStorage, getsockname, getsockopt, sockopt};
use std::net::SocketAddr;
use tokio::net::{TcpListener, TcpStream};

pub(in crate::vmm) struct Listener(TcpListener);

impl Listener {
    pub(in crate::vmm) fn from_fd(descriptor: OwnedFd, expected: &SocketAddr) -> io::Result<Self> {
        use std::os::fd::AsRawFd;
        if getsockopt(&descriptor, sockopt::SockType)? != SockType::Stream
            || !is_listening(&descriptor)?
        {
            return Err(invalid("SSH descriptor must be a listening stream socket"));
        }
        let address: SockaddrStorage = getsockname(descriptor.as_raw_fd())?;
        if address.as_sockaddr_in().is_none() && address.as_sockaddr_in6().is_none() {
            return Err(invalid("SSH descriptor is not a TCP socket"));
        }
        let socket = std::net::TcpListener::from(descriptor);
        let actual = socket.local_addr()?;
        if actual != *expected {
            return Err(invalid(
                "SSH TCP descriptor endpoint does not match configuration",
            ));
        }
        socket.set_nonblocking(true)?;
        Ok(Self(TcpListener::from_std(socket)?))
    }

    pub(in crate::vmm) async fn accept(&self) -> io::Result<TcpStream> {
        let (socket, _) = self.0.accept().await?;
        socket.set_nodelay(true)?;
        Ok(socket)
    }
}

#[cfg(not(target_os = "macos"))]
fn is_listening(descriptor: &OwnedFd) -> io::Result<bool> {
    getsockopt(descriptor, sockopt::AcceptConn).map_err(Into::into)
}

#[cfg(target_os = "macos")]
fn is_listening(descriptor: &OwnedFd) -> io::Result<bool> {
    use std::os::fd::{AsRawFd, FromRawFd};
    let raw = descriptor.as_raw_fd();
    // Darwin rejects SO_ACCEPTCONN with ENOPROTOOPT. Its accept syscall checks
    // the same flag before returning EWOULDBLOCK. Any client consumed by this
    // check is closed before the forwarding task starts.
    // SAFETY: raw remains owned throughout these descriptor-only operations.
    let flags = unsafe { libc::fcntl(raw, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(raw, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    match nix::sys::socket::accept(raw) {
        Ok(accepted) => {
            // SAFETY: accept returned a new descriptor exclusively owned here.
            drop(unsafe { OwnedFd::from_raw_fd(accepted) });
            Ok(true)
        }
        Err(nix::errno::Errno::EAGAIN) => Ok(true),
        Err(nix::errno::Errno::EINVAL) => Ok(false),
        Err(error) => Err(error.into()),
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
