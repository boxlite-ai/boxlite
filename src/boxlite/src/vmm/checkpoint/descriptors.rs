//! Bounded, acknowledged descriptor frames on an unbuffered Unix stream.

use serde::{Serialize, de::DeserializeOwned};
use std::io::{self, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::net::UnixStream;

pub const MAX_JSON: usize = 16 << 20;
pub const MAX_FDS: usize = 16_384;
const BATCH: usize = 64;
const HEADER: usize = 40;

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

/// The generation switch also rejects ancillary data; no buffered read may
/// discard a descriptor before the bounded frame parser takes ownership.
pub(crate) fn read_control<T: DeserializeOwned>(stream: &UnixStream) -> io::Result<T> {
    let mut line = Vec::new();
    while line.len() < super::protocol::MAX_MESSAGE_BYTES {
        let mut byte = [0];
        receive_bytes(stream, &mut byte, false)?;
        line.push(byte[0]);
        if byte[0] == b'\n' {
            return super::protocol::parse_line(&line);
        }
    }
    Err(invalid("control message exceeds the size limit"))
}

/// Reject descriptor transfers before receiving rights if the process cannot
/// retain the complete set plus existing descriptors and worker headroom.
pub fn preflight(count: usize) -> io::Result<()> {
    if count > MAX_FDS {
        return Err(invalid("checkpoint descriptor limit exceeded"));
    }
    let mut limit = std::mem::MaybeUninit::<libc::rlimit>::uninit();
    // SAFETY: getrlimit initializes a correctly sized writable structure.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, limit.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful getrlimit initialized limit.
    let limit = unsafe { limit.assume_init() }.rlim_cur;
    #[cfg(target_os = "linux")]
    let used = std::fs::read_dir("/proc/self/fd")?.count();
    #[cfg(not(target_os = "linux"))]
    let used = 128;
    if (used + count + 64) as libc::rlim_t > limit {
        return Err(invalid("insufficient checkpoint descriptor headroom"));
    }
    Ok(())
}

pub fn check_peer(stream: &UnixStream) -> io::Result<()> {
    #[cfg(target_os = "linux")]
    let uid = {
        let mut peer = std::mem::MaybeUninit::<libc::ucred>::uninit();
        let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        // SAFETY: the output pointer and length describe a ucred buffer.
        if unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                peer.as_mut_ptr().cast(),
                &mut length,
            )
        } != 0
            || length as usize != std::mem::size_of::<libc::ucred>()
        {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: getsockopt initialized the complete structure.
        unsafe { peer.assume_init() }.uid
    };
    #[cfg(not(target_os = "linux"))]
    let uid = {
        let (mut uid, mut gid) = (0, 0);
        // SAFETY: uid/gid point to writable values.
        if unsafe { libc::getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 {
            return Err(io::Error::last_os_error());
        }
        uid
    };
    // SAFETY: geteuid has no pointer arguments or side effects.
    if uid != unsafe { libc::geteuid() } {
        return Err(invalid("checkpoint peer has a different uid"));
    }
    Ok(())
}

pub fn send<T: Serialize>(
    mut stream: &UnixStream,
    operation: [u8; 16],
    value: &T,
    files: &[OwnedFd],
) -> io::Result<()> {
    check_peer(stream)?;
    let json = serde_json::to_vec(value).map_err(io::Error::other)?;
    if json.len() > MAX_JSON || files.len() > MAX_FDS {
        return Err(invalid("checkpoint frame exceeds limits"));
    }
    for sequence in 0..files.len().max(1).div_ceil(BATCH) {
        let start = (sequence * BATCH).min(files.len());
        let batch = &files[start..(start + BATCH).min(files.len())];
        let mut header = [0u8; HEADER];
        header[..4].copy_from_slice(b"BXC2");
        header[4..20].copy_from_slice(&operation);
        for (offset, value) in [
            (20, sequence),
            (24, files.len()),
            (28, if sequence == 0 { json.len() } else { 0 }),
            (32, batch.len()),
        ] {
            header[offset..offset + 4].copy_from_slice(&(value as u32).to_le_bytes());
        }
        send_header(stream, &header, batch)?;
        if sequence == 0 {
            stream.write_all(&json)?;
        }
        let mut ack = [0];
        receive_bytes(stream, &mut ack, false)?;
        if ack != [0xac] {
            return Err(invalid("checkpoint batch was not acknowledged"));
        }
    }
    Ok(())
}

pub fn receive<T: DeserializeOwned>(
    mut stream: &UnixStream,
    operation: [u8; 16],
) -> io::Result<(T, Vec<OwnedFd>)> {
    check_peer(stream)?;
    let mut files = Vec::new();
    let mut json = Vec::new();
    let mut total = None;
    for sequence in 0..=MAX_FDS / BATCH {
        let (header, batch) = receive_header(stream)?;
        let number = |at| u32::from_le_bytes(header[at..at + 4].try_into().unwrap()) as usize;
        let (count, length, attached) = (number(24), number(28), number(32));
        if &header[..4] != b"BXC2"
            || header[4..20] != operation
            || number(20) != sequence
            || header[36..].iter().any(|&b| b != 0)
            || count > MAX_FDS
            || length > MAX_JSON
            || attached != batch.len()
            || attached != (count.saturating_sub(files.len())).min(BATCH)
            || total.is_some_and(|n| n != count)
            || (sequence != 0 && length != 0)
        {
            return Err(invalid("invalid checkpoint descriptor frame"));
        }
        if sequence == 0 {
            preflight(count)?;
            total = Some(count);
            json.resize(length, 0);
            receive_bytes(stream, &mut json, false)?;
        }
        files.extend(batch);
        stream.write_all(&[0xac])?;
        if files.len() == count {
            return Ok((serde_json::from_slice(&json).map_err(invalid_json)?, files));
        }
    }
    Err(invalid("too many checkpoint descriptor batches"))
}

fn invalid_json(error: serde_json::Error) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, error)
}

fn send_header(
    mut stream: &UnixStream,
    header: &[u8; HEADER],
    files: &[OwnedFd],
) -> io::Result<()> {
    if files.len() > BATCH {
        return Err(invalid("checkpoint batch exceeds descriptor limit"));
    }
    // usize storage keeps cmsghdr naturally aligned on both supported hosts.
    let mut control = [0usize; 128];
    let mut iov = libc::iovec {
        iov_base: header.as_ptr().cast_mut().cast(),
        iov_len: HEADER,
    };
    // SAFETY: zero initializes msghdr's nullable pointers and flags.
    let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    if !files.is_empty() {
        let bytes = files.len() * std::mem::size_of::<libc::c_int>();
        message.msg_control = control.as_mut_ptr().cast();
        // SAFETY: byte count is bounded by BATCH and control is large enough.
        message.msg_controllen = unsafe { libc::CMSG_SPACE(bytes as u32) } as _;
        // SAFETY: msghdr owns aligned control space of the stated size.
        unsafe {
            let cmsg = libc::CMSG_FIRSTHDR(&message);
            (*cmsg).cmsg_level = libc::SOL_SOCKET;
            (*cmsg).cmsg_type = libc::SCM_RIGHTS;
            (*cmsg).cmsg_len = libc::CMSG_LEN(bytes as u32) as _;
            let target = libc::CMSG_DATA(cmsg).cast::<libc::c_int>();
            for (index, file) in files.iter().enumerate() {
                target.add(index).write(file.as_raw_fd());
            }
        }
    }
    // SAFETY: all input buffers remain valid throughout sendmsg.
    #[cfg(target_os = "linux")]
    let flags = libc::MSG_NOSIGNAL;
    #[cfg(not(target_os = "linux"))]
    let flags = 0;
    let sent = unsafe { libc::sendmsg(stream.as_raw_fd(), &message, flags) };
    if sent <= 0 {
        return Err(io::Error::last_os_error());
    }
    stream.write_all(&header[sent as usize..])
}

fn receive_header(stream: &UnixStream) -> io::Result<([u8; HEADER], Vec<OwnedFd>)> {
    let mut header = [0; HEADER];
    let files = receive_bytes(stream, &mut header, true)?;
    Ok((header, files))
}

fn receive_bytes(
    stream: &UnixStream,
    bytes: &mut [u8],
    allow_descriptors: bool,
) -> io::Result<Vec<OwnedFd>> {
    let mut files = Vec::new();
    let mut offset = 0;
    while offset < bytes.len() {
        let mut control = [0usize; 128];
        let mut iov = libc::iovec {
            iov_base: bytes[offset..].as_mut_ptr().cast(),
            iov_len: bytes.len() - offset,
        };
        // SAFETY: zero initializes optional pointers in msghdr.
        let mut message: libc::msghdr = unsafe { std::mem::zeroed() };
        message.msg_iov = &mut iov;
        message.msg_iovlen = 1;
        message.msg_control = control.as_mut_ptr().cast();
        message.msg_controllen = std::mem::size_of_val(&control) as _;
        #[cfg(target_os = "linux")]
        let flags = libc::MSG_CMSG_CLOEXEC;
        #[cfg(not(target_os = "linux"))]
        let flags = 0;
        // SAFETY: writable header/control buffers match the advertised sizes.
        let read = unsafe { libc::recvmsg(stream.as_raw_fd(), &mut message, flags) };
        if read < 0 {
            return Err(io::Error::last_os_error());
        }
        if read == 0 {
            return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
        }
        let mut unexpected = false;
        let mut descriptor_error = None;
        // SAFETY: kernel initialized the control buffer and its length; all FDs
        // become owned immediately, including on a rejected/truncated message.
        unsafe {
            let mut cmsg = libc::CMSG_FIRSTHDR(&message);
            while !cmsg.is_null() {
                if (*cmsg).cmsg_level == libc::SOL_SOCKET && (*cmsg).cmsg_type == libc::SCM_RIGHTS {
                    let length = (*cmsg).cmsg_len as usize - libc::CMSG_LEN(0) as usize;
                    for index in 0..length / std::mem::size_of::<i32>() {
                        let fd = libc::CMSG_DATA(cmsg)
                            .cast::<i32>()
                            .add(index)
                            .read_unaligned();
                        let owned = OwnedFd::from_raw_fd(fd);
                        if libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) < 0 {
                            descriptor_error = Some(io::Error::last_os_error());
                        }
                        files.push(owned);
                    }
                } else {
                    unexpected = true;
                }
                cmsg = libc::CMSG_NXTHDR(&message, cmsg);
            }
        }
        if unexpected
            || message.msg_flags & (libc::MSG_CTRUNC | libc::MSG_TRUNC) != 0
            || files.len() > BATCH
            || (!allow_descriptors && !files.is_empty())
        {
            return Err(invalid("truncated or unexpected checkpoint ancillary data"));
        }
        if let Some(error) = descriptor_error {
            return Err(error);
        }
        offset += read as usize;
    }
    Ok(files)
}

#[cfg(test)]
#[path = "tests/descriptors.rs"]
mod tests;
