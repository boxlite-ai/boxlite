//! Configure the guest network namespace before containers inherit it.

use boxlite_shared::errors::{BoxliteError, BoxliteResult};
use nix::libc;
use std::ffi::{OsStr, OsString};
use std::io;
use std::net::Ipv4Addr;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;

/// Localhost is required even when Guest.Init has no external network config.
pub(crate) fn configure_loopback() -> BoxliteResult<()> {
    let fd = ipv4_socket()?;
    bring_up_interface(&fd, &mut interface_request(OsStr::new("lo"))?)
}

/// Configure the selected interface, or the first non-loopback interface if
/// `interface` is empty. The address and default gateway are optional.
/// Kept async for the Guest.Init caller; the ioctls complete synchronously.
pub async fn configure_network_from_config(
    interface: &str,
    ip: Option<&str>,
    gateway: Option<&str>,
) -> BoxliteResult<()> {
    let detected;
    let interface = if interface.is_empty() {
        detected = detect_interface()?;
        detected.as_os_str()
    } else {
        OsStr::new(interface)
    };
    let mut req = interface_request(interface)?;
    let ip = ip.map(parse_ip_prefix).transpose()?;
    let gateway: Option<Ipv4Addr> = gateway
        .map(|value| {
            value.parse().map_err(|e| {
                BoxliteError::Internal(format!("Invalid gateway address '{value}': {e}"))
            })
        })
        .transpose()?;

    tracing::debug!(?interface, ?ip, ?gateway, "Configuring guest network");
    let fd = ipv4_socket()?;
    bring_up_interface(&fd, &mut req)?;

    if let Some((address, prefix)) = ip {
        // Prefix 0 has an all-zero mask; avoid shifting a u32 by 32 bits.
        let mask = u32::MAX.checked_shl(32 - u32::from(prefix)).unwrap_or(0);
        req.ifr_ifru.ifru_addr = ipv4_sockaddr(address);
        interface_ioctl(&fd, libc::SIOCSIFADDR as _, &mut req, "set IPv4 address")?;
        req.ifr_ifru.ifru_netmask = ipv4_sockaddr(Ipv4Addr::from(mask));
        interface_ioctl(&fd, libc::SIOCSIFNETMASK as _, &mut req, "set IPv4 netmask")?;
    }
    if let Some(gateway) = gateway {
        add_default_route(&fd, &mut req, gateway)?;
    }
    Ok(())
}

fn detect_interface() -> BoxliteResult<OsString> {
    for entry in std::fs::read_dir("/sys/class/net")? {
        let name = entry?.file_name();
        if name != "lo" {
            return Ok(name);
        }
    }
    Err(BoxliteError::Internal(
        "No non-loopback interface found".into(),
    ))
}

fn ipv4_socket() -> BoxliteResult<OwnedFd> {
    // SAFETY: socket takes no pointers. A successful call returns a fresh fd.
    let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0) };
    if fd < 0 {
        return Err(BoxliteError::Internal(format!(
            "open IPv4 control socket: {}",
            io::Error::last_os_error()
        )));
    }
    // SAFETY: socket succeeded and ownership is transferred once.
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn interface_request(name: &OsStr) -> BoxliteResult<libc::ifreq> {
    let bytes = name.as_bytes();
    if bytes.is_empty() || bytes.len() >= libc::IFNAMSIZ || bytes.contains(&0) {
        return Err(BoxliteError::InvalidArgument(format!(
            "Invalid network interface: {name:?}"
        )));
    }
    // SAFETY: zero is valid for the name and all fields of the ifreq union.
    let mut req: libc::ifreq = unsafe { std::mem::zeroed() };
    for (dst, &src) in req.ifr_name.iter_mut().zip(bytes) {
        *dst = src as libc::c_char;
    }
    Ok(req)
}

fn interface_ioctl(
    fd: &OwnedFd,
    op: libc::Ioctl,
    req: &mut libc::ifreq,
    action: &str,
) -> BoxliteResult<()> {
    // SAFETY: all callers use Linux ioctls that read or write an ifreq.
    if unsafe { libc::ioctl(fd.as_raw_fd(), op, std::ptr::from_mut(req)) } < 0 {
        return Err(BoxliteError::Internal(format!(
            "{action}: {}",
            io::Error::last_os_error()
        )));
    }
    Ok(())
}

fn bring_up_interface(fd: &OwnedFd, req: &mut libc::ifreq) -> BoxliteResult<()> {
    interface_ioctl(fd, libc::SIOCGIFFLAGS as _, req, "get interface flags")?;
    // SAFETY: SIOCGIFFLAGS initialized the flags member.
    let flags = unsafe { req.ifr_ifru.ifru_flags };
    let up = libc::IFF_UP as libc::c_short;
    if flags & up == 0 {
        req.ifr_ifru.ifru_flags = flags | up;
        interface_ioctl(fd, libc::SIOCSIFFLAGS as _, req, "bring up interface")?;
    }
    Ok(())
}

fn ipv4_sockaddr(ip: Ipv4Addr) -> libc::sockaddr {
    let addr = libc::sockaddr_in {
        sin_family: libc::AF_INET as libc::sa_family_t,
        sin_port: 0,
        sin_addr: libc::in_addr {
            s_addr: u32::from_ne_bytes(ip.octets()),
        },
        sin_zero: [0; 8],
    };
    // SAFETY: both Linux structures are 16 bytes with the same family field;
    // the remaining bytes are copied verbatim into sockaddr.sa_data.
    unsafe { std::mem::transmute::<libc::sockaddr_in, libc::sockaddr>(addr) }
}

fn add_default_route(fd: &OwnedFd, req: &mut libc::ifreq, gateway: Ipv4Addr) -> BoxliteResult<()> {
    // SAFETY: rtentry consists of integers, sockaddrs and a nullable pointer.
    let mut route: libc::rtentry = unsafe { std::mem::zeroed() };
    route.rt_dst = ipv4_sockaddr(Ipv4Addr::UNSPECIFIED);
    route.rt_genmask = ipv4_sockaddr(Ipv4Addr::UNSPECIFIED);
    route.rt_gateway = ipv4_sockaddr(gateway);
    route.rt_flags = (libc::RTF_UP | libc::RTF_GATEWAY) as libc::c_ushort;
    route.rt_dev = req.ifr_name.as_mut_ptr();
    // SAFETY: SIOCADDRT reads an rtentry and the NUL-terminated interface name,
    // both of which are live until ioctl returns.
    if unsafe {
        libc::ioctl(
            fd.as_raw_fd(),
            libc::SIOCADDRT as _,
            &mut route as *mut libc::rtentry,
        )
    } < 0
    {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EEXIST) {
            return Err(BoxliteError::Internal(format!(
                "set default gateway {gateway}: {error}"
            )));
        }
    }
    Ok(())
}

fn parse_ip_prefix(value: &str) -> BoxliteResult<(Ipv4Addr, u8)> {
    let (address, prefix) = value.split_once('/').unwrap_or((value, "24"));
    let address = address
        .parse()
        .map_err(|e| BoxliteError::Internal(format!("Invalid IPv4 address '{address}': {e}")))?;
    let prefix = prefix
        .parse::<u8>()
        .ok()
        .filter(|&p| p <= 32)
        .ok_or_else(|| {
            BoxliteError::Internal(format!("Invalid IPv4 prefix '{prefix}': expected 0–32"))
        })?;
    Ok((address, prefix))
}
