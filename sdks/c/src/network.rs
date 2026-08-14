//! Network operations for the BoxLite C SDK.

use std::ffi::{CStr, CString};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::os::fd::IntoRawFd;
use std::os::raw::{c_char, c_void};
use std::path::PathBuf;
use std::ptr;
use std::sync::{Arc, Mutex};

use tokio::runtime::Runtime as TokioRuntime;

use boxlite::litebox::{
    BoxTunnel as CoreBoxTunnel, NetworkHandle as CoreNetworkHandle, SocketAddress,
    TunnelForwarder as CoreTunnelForwarder,
};
use boxlite::{BoxConnection, BoxliteError};

use crate::error::{BoxliteErrorCode, error_to_code, null_pointer_error, write_error};
use crate::event_queue::{
    CTunnelForwarderCloseCb, CTunnelForwarderWaitCb, EventQueue, RuntimeEvent, push_event,
};
use crate::{
    CBoxHandle, CBoxNetworkHandle, CBoxTunnelHandle, CBoxliteError, CTunnelForwarderHandle,
};

async fn connection_fd(
    mut connection: BoxConnection,
) -> Result<std::os::fd::OwnedFd, BoxliteError> {
    let (sdk, mut bridge) = tokio::net::UnixStream::pair()
        .map_err(|error| BoxliteError::Network(format!("create SDK socket bridge: {error}")))?;
    tokio::spawn(async move {
        // The relay is detached, so a failure here has nowhere to be returned;
        // the caller only sees EOF on its half. Log it so it is diagnosable.
        if let Err(error) = tokio::io::copy_bidirectional(&mut connection, &mut bridge).await {
            tracing::debug!(%error, "box tunnel bridge relay ended");
        }
    });
    sdk.into_std()
        .map(std::os::fd::OwnedFd::from)
        .map_err(|error| BoxliteError::Network(format!("export SDK socket: {error}")))
}

/// Opaque handle for network operations on a box.
pub struct BoxNetworkHandle {
    handle: CoreNetworkHandle,
    tokio_rt: Arc<TokioRuntime>,
    queue: Arc<EventQueue>,
}

/// Opaque long-lived listener handle.
pub struct TunnelForwarderHandle {
    handle: CoreTunnelForwarder,
    tokio_rt: Arc<TokioRuntime>,
    queue: Arc<EventQueue>,
}

pub type BoxliteSocketAddressKind = u32;

#[allow(non_upper_case_globals)]
pub const BoxliteSocketTcp: BoxliteSocketAddressKind = 0;
#[allow(non_upper_case_globals)]
pub const BoxliteSocketUnix: BoxliteSocketAddressKind = 1;

/// Listener address. Input strings are borrowed for the duration of a call.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct BoxliteSocketAddress {
    pub kind: BoxliteSocketAddressKind,
    pub host: *const c_char,
    pub port: u16,
    pub path: *const c_char,
}

/// Opaque handle for a one-shot prepared tunnel.
pub struct BoxTunnelHandle {
    handle: Mutex<Option<CoreBoxTunnel>>,
    tokio_rt: Arc<TokioRuntime>,
    queue: Arc<EventQueue>,
}

impl BoxTunnelHandle {
    fn take(&self) -> Result<CoreBoxTunnel, BoxliteError> {
        self.handle
            .lock()
            .map_err(|_| BoxliteError::Internal("tunnel lock poisoned".into()))?
            .take()
            .ok_or_else(|| {
                BoxliteError::InvalidState("tunnel connection has already been consumed".into())
            })
    }
}

/// Borrow the box's network capability into a new owned handle.
///
/// On success, `*out_network` must be released with `boxlite_network_free`.
/// Returns `InvalidArgument` for null input/output pointers and writes details
/// to `out_error` when provided.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_network(
    handle: *mut CBoxHandle,
    out_network: *mut *mut CBoxNetworkHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if handle.is_null() {
            write_error(out_error, null_pointer_error("handle"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_network.is_null() {
            write_error(out_error, null_pointer_error("out_network"));
            return BoxliteErrorCode::InvalidArgument;
        }

        *out_network = ptr::null_mut();
        let handle_ref = &*handle;
        *out_network = Box::into_raw(Box::new(BoxNetworkHandle {
            handle: handle_ref.handle.network(),
            tokio_rt: handle_ref.tokio_rt.clone(),
            queue: handle_ref.queue.clone(),
        }));
        BoxliteErrorCode::Ok
    }
}

unsafe fn parse_socket_address(
    address: *const BoxliteSocketAddress,
) -> Result<SocketAddress, BoxliteError> {
    if address.is_null() {
        return Err(null_pointer_error("listen"));
    }
    let address = unsafe { &*address };
    match address.kind {
        kind if kind == BoxliteSocketTcp => {
            if !address.path.is_null() {
                return Err(BoxliteError::InvalidArgument(
                    "TCP listener path must be null".into(),
                ));
            }
            let host = if address.host.is_null() {
                ""
            } else {
                unsafe { CStr::from_ptr(address.host) }
                    .to_str()
                    .map_err(|_| {
                        BoxliteError::InvalidArgument("listener host is not UTF-8".into())
                    })?
            };
            let ip = if host.is_empty() {
                IpAddr::V4(Ipv4Addr::LOCALHOST)
            } else {
                host.parse::<IpAddr>().map_err(|_| {
                    BoxliteError::InvalidArgument("TCP listener host must be a numeric IP".into())
                })?
            };
            Ok(SocketAddress::Tcp(SocketAddr::new(ip, address.port)))
        }
        kind if kind == BoxliteSocketUnix => {
            if !address.host.is_null() || address.port != 0 {
                return Err(BoxliteError::InvalidArgument(
                    "Unix listener host must be null and port must be zero".into(),
                ));
            }
            if address.path.is_null() {
                return Err(null_pointer_error("listen.path"));
            }
            let path = PathBuf::from(
                unsafe { CStr::from_ptr(address.path) }
                    .to_str()
                    .map_err(|_| {
                        BoxliteError::InvalidArgument("listener path is not UTF-8".into())
                    })?,
            );
            if !path.is_absolute() {
                return Err(BoxliteError::InvalidArgument(
                    "Unix listener path must be absolute".into(),
                ));
            }
            Ok(SocketAddress::Unix(path))
        }
        kind => Err(BoxliteError::InvalidArgument(format!(
            "unknown tunnel listener address kind: {kind}"
        ))),
    }
}

/// Return a newly allocated canonical address string.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_tunnel_forwarder_address(
    forwarder: *mut CTunnelForwarderHandle,
    out_address: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if forwarder.is_null() {
            write_error(out_error, null_pointer_error("forwarder"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_address.is_null() {
            write_error(out_error, null_pointer_error("out_address"));
            return BoxliteErrorCode::InvalidArgument;
        }
        *out_address = CString::new((*forwarder).handle.local_addr().to_string())
            .expect("rendered listener address has no NUL")
            .into_raw();
        BoxliteErrorCode::Ok
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_tunnel_forwarder_wait(
    forwarder: *mut CTunnelForwarderHandle,
    cb: CTunnelForwarderWaitCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if forwarder.is_null() {
        unsafe { write_error(out_error, null_pointer_error("forwarder")) };
        return BoxliteErrorCode::InvalidArgument;
    }
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let forwarder = unsafe { &*forwarder };
    let handle = forwarder.handle.clone();
    let queue = forwarder.queue.clone();
    let user_data = user_data as usize;
    forwarder.tokio_rt.spawn(async move {
        push_event(
            &queue,
            RuntimeEvent::TunnelForwarderWait {
                cb,
                user_data,
                result: handle.wait().await,
            },
        )
        .await;
    });
    BoxliteErrorCode::Ok
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_tunnel_forwarder_close(
    forwarder: *mut CTunnelForwarderHandle,
    cb: CTunnelForwarderCloseCb,
    user_data: *mut c_void,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    if forwarder.is_null() {
        unsafe { write_error(out_error, null_pointer_error("forwarder")) };
        return BoxliteErrorCode::InvalidArgument;
    }
    let cb = crate::unwrap_cb_or_return!(cb, out_error);
    let forwarder = unsafe { &*forwarder };
    let handle = forwarder.handle.clone();
    let queue = forwarder.queue.clone();
    let user_data = user_data as usize;
    forwarder.tokio_rt.spawn(async move {
        push_event(
            &queue,
            RuntimeEvent::TunnelForwarderClose {
                cb,
                user_data,
                result: handle.close().await,
            },
        )
        .await;
    });
    BoxliteErrorCode::Ok
}

/// Initiate non-blocking cancellation and release the caller's handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_tunnel_forwarder_free(forwarder: *mut CTunnelForwarderHandle) {
    if !forwarder.is_null() {
        let forwarder = unsafe { Box::from_raw(forwarder) };
        let handle = forwarder.handle.clone();
        forwarder.tokio_rt.spawn(async move {
            let _ = handle.close().await;
        });
        drop(forwarder);
    }
}

/// Release a network handle. Accepts NULL and does not affect the box handle.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_network_free(network: *mut CBoxNetworkHandle) {
    if !network.is_null() {
        unsafe { drop(Box::from_raw(network)) };
    }
}

/// Prepare a one-shot tunnel to `port` in the box.
///
/// On success, `*out_tunnel` owns a handle that must be released with
/// `boxlite_tunnel_free`. Returns `InvalidArgument` for a null network/output
/// pointer or port zero, with details written to `out_error` when provided.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_network_tunnel(
    network: *mut CBoxNetworkHandle,
    port: u16,
    out_tunnel: *mut *mut CBoxTunnelHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if network.is_null() {
            write_error(out_error, null_pointer_error("network"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_tunnel.is_null() {
            write_error(out_error, null_pointer_error("out_tunnel"));
            return BoxliteErrorCode::InvalidArgument;
        }
        *out_tunnel = ptr::null_mut();
        if port == 0 {
            write_error(
                out_error,
                BoxliteError::InvalidArgument("tunnel port must be non-zero".into()),
            );
            return BoxliteErrorCode::InvalidArgument;
        }

        let target: SocketAddr = match format!("{}:{port}", boxlite::net::constants::GUEST_IP)
            .parse()
        {
            Ok(target) => target,
            Err(error) => {
                write_error(
                    out_error,
                    BoxliteError::Internal(format!("invalid BoxLite guest IP constant: {error}")),
                );
                return BoxliteErrorCode::Internal;
            }
        };
        let network_ref = &*network;
        match network_ref
            .tokio_rt
            .block_on(network_ref.handle.tunnel(target))
        {
            Ok(handle) => {
                *out_tunnel = Box::into_raw(Box::new(BoxTunnelHandle {
                    handle: Mutex::new(Some(handle)),
                    tokio_rt: network_ref.tokio_rt.clone(),
                    queue: network_ref.queue.clone(),
                }));
                BoxliteErrorCode::Ok
            }
            Err(error) => {
                let code = error_to_code(&error);
                write_error(out_error, error);
                code
            }
        }
    }
}

/// Release an unconsumed tunnel. Existing connections and forwarders remain alive.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_tunnel_free(tunnel: *mut CBoxTunnelHandle) {
    if !tunnel.is_null() {
        unsafe { drop(Box::from_raw(tunnel)) };
    }
}

/// Read the public URL of a remotely served tunnel, without consuming it.
///
/// On success `*out_uri` is an allocated string the caller must release with
/// `boxlite_free_string`, or NULL for a local tunnel — a local descriptor is
/// already a live connection, so it has no address; use
/// `boxlite_tunnel_connect` for those. Errors are returned as a
/// `BoxliteErrorCode` and described through `out_error` when provided.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_tunnel_uri(
    tunnel: *mut CBoxTunnelHandle,
    out_uri: *mut *mut c_char,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if tunnel.is_null() {
            write_error(out_error, null_pointer_error("tunnel"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_uri.is_null() {
            write_error(out_error, null_pointer_error("out_uri"));
            return BoxliteErrorCode::InvalidArgument;
        }
        *out_uri = ptr::null_mut();

        let tunnel_ref = &*tunnel;
        let guard = match tunnel_ref.handle.lock() {
            Ok(guard) => guard,
            Err(_) => {
                let error = BoxliteError::Internal("tunnel lock poisoned".into());
                write_error(out_error, error);
                return BoxliteErrorCode::Internal;
            }
        };
        let Some(handle) = guard.as_ref() else {
            let error =
                BoxliteError::InvalidState("tunnel connection has already been consumed".into());
            write_error(out_error, error);
            return BoxliteErrorCode::InvalidState;
        };
        match handle.uri() {
            Some(uri) => match CString::new(uri) {
                Ok(uri) => {
                    *out_uri = uri.into_raw();
                    BoxliteErrorCode::Ok
                }
                Err(_) => {
                    write_error(
                        out_error,
                        BoxliteError::Internal("tunnel URI contains a NUL byte".into()),
                    );
                    BoxliteErrorCode::Internal
                }
            },
            None => BoxliteErrorCode::Ok,
        }
    }
}

/// Consume the tunnel and return its owned file descriptor.
///
/// On success, the caller owns `*out_fd` and must close it.
/// On failure `*out_fd` remains -1 and `out_error`
/// receives details when provided.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_tunnel_connect(
    tunnel: *mut CBoxTunnelHandle,
    out_fd: *mut i32,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if tunnel.is_null() {
            write_error(out_error, null_pointer_error("tunnel"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_fd.is_null() {
            write_error(out_error, null_pointer_error("out_fd"));
            return BoxliteErrorCode::InvalidArgument;
        }
        *out_fd = -1;

        let tunnel_ref = &*tunnel;
        let prepared = match tunnel_ref.take() {
            Ok(tunnel) => tunnel,
            Err(error) => {
                let code = error_to_code(&error);
                write_error(out_error, error);
                return code;
            }
        };
        let owned_fd = tunnel_ref.tokio_rt.block_on(async {
            let connection = prepared.connect()?;
            // A socket-backed connection already owns exactly the descriptor
            // the caller wants, so surrender it instead of inserting another
            // socket pair and copy task. Only the remote transport, whose
            // socket belongs to the HTTP client, needs that bridge.
            match connection.raw_fd() {
                Some(_) => connection.into_fd(),
                None => connection_fd(connection).await,
            }
        });

        match owned_fd {
            Ok(fd) => {
                *out_fd = fd.into_raw_fd();
                BoxliteErrorCode::Ok
            }
            Err(error) => {
                let code = error_to_code(&error);
                write_error(out_error, error);
                code
            }
        }
    }
}

/// Bind a local listener synchronously and start forwarding accepted clients.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_tunnel_forward(
    tunnel: *mut CBoxTunnelHandle,
    listen: *const BoxliteSocketAddress,
    out_forwarder: *mut *mut CTunnelForwarderHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if tunnel.is_null() {
            write_error(out_error, null_pointer_error("tunnel"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_forwarder.is_null() {
            write_error(out_error, null_pointer_error("out_forwarder"));
            return BoxliteErrorCode::InvalidArgument;
        }
        *out_forwarder = ptr::null_mut();
        let listen = match parse_socket_address(listen) {
            Ok(address) => address,
            Err(error) => {
                let code = error_to_code(&error);
                write_error(out_error, error);
                return code;
            }
        };
        let tunnel = &*tunnel;
        let prepared = match tunnel.take() {
            Ok(tunnel) => tunnel,
            Err(error) => {
                let code = error_to_code(&error);
                write_error(out_error, error);
                return code;
            }
        };
        match tunnel.tokio_rt.block_on(prepared.forward(listen)) {
            Ok(handle) => {
                *out_forwarder = Box::into_raw(Box::new(TunnelForwarderHandle {
                    handle,
                    tokio_rt: tunnel.tokio_rt.clone(),
                    queue: tunnel.queue.clone(),
                }));
                BoxliteErrorCode::Ok
            }
            Err(error) => {
                let code = error_to_code(&error);
                write_error(out_error, error);
                code
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_address_rejects_irrelevant_fields() {
        let path = CString::new("/tmp/app.sock").unwrap();
        let tcp = BoxliteSocketAddress {
            kind: BoxliteSocketTcp,
            host: ptr::null(),
            port: 0,
            path: path.as_ptr(),
        };
        assert!(unsafe { parse_socket_address(&tcp) }.is_err());

        let host = CString::new("127.0.0.1").unwrap();
        let unix = BoxliteSocketAddress {
            kind: BoxliteSocketUnix,
            host: host.as_ptr(),
            port: 0,
            path: path.as_ptr(),
        };
        assert!(unsafe { parse_socket_address(&unix) }.is_err());
    }

    #[test]
    fn listener_address_defaults_empty_tcp_host_to_loopback() {
        let address = BoxliteSocketAddress {
            kind: BoxliteSocketTcp,
            host: ptr::null(),
            port: 0,
            path: ptr::null(),
        };
        assert_eq!(
            unsafe { parse_socket_address(&address) }.unwrap(),
            SocketAddress::Tcp("127.0.0.1:0".parse().unwrap())
        );
    }

    #[test]
    fn listener_address_rejects_unknown_kind() {
        let address = BoxliteSocketAddress {
            kind: 42,
            host: ptr::null(),
            port: 0,
            path: ptr::null(),
        };
        let error = unsafe { parse_socket_address(&address) }.unwrap_err();
        assert!(
            error
                .to_string()
                .contains("unknown tunnel listener address kind")
        );
    }
}
