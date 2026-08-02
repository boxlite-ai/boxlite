//! Network operations for the BoxLite C SDK.

use std::ffi::CString;
use std::net::SocketAddr;
use std::os::fd::IntoRawFd;
use std::os::raw::c_char;
use std::ptr;
use std::sync::Arc;

use tokio::runtime::Runtime as TokioRuntime;

use boxlite::litebox::{BoxTunnel as CoreBoxTunnel, NetworkHandle as CoreNetworkHandle};
use boxlite::{BoxConnection, BoxliteError};

use crate::error::{BoxliteErrorCode, error_to_code, null_pointer_error, write_error};
use crate::{CBoxHandle, CBoxNetworkHandle, CBoxTunnelHandle, CBoxliteError};

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
}

/// Opaque handle for a one-shot box service tunnel.
pub struct BoxTunnelHandle {
    handle: Option<CoreBoxTunnel>,
    tokio_rt: Arc<TokioRuntime>,
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
        }));
        BoxliteErrorCode::Ok
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
                    handle: Some(handle),
                    tokio_rt: network_ref.tokio_rt.clone(),
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

/// Release a tunnel handle and any unconsumed connection. Accepts NULL.
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
        match tunnel_ref.handle.as_ref() {
            Some(handle) => {
                let Some(uri) = handle.uri() else {
                    return BoxliteErrorCode::Ok;
                };
                match CString::new(uri) {
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
                }
            }
            None => {
                let error = BoxliteError::InvalidState(
                    "tunnel connection has already been consumed".into(),
                );
                let code = error_to_code(&error);
                write_error(out_error, error);
                code
            }
        }
    }
}

/// Consume a tunnel's single connection and return its owned file descriptor.
///
/// On success, the caller owns `*out_fd` and must close it. A second call
/// returns `InvalidState`. On failure `*out_fd` remains -1 and `out_error`
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

        let tunnel_ref = &mut *tunnel;
        let Some(handle) = tunnel_ref.handle.take() else {
            let error =
                BoxliteError::InvalidState("tunnel connection has already been consumed".into());
            let code = error_to_code(&error);
            write_error(out_error, error);
            return code;
        };
        // `connect` registers the descriptor with the reactor, so it needs the
        // runtime even though it is not itself async.
        let owned_fd = tunnel_ref.tokio_rt.block_on(async {
            let connection = handle.connect()?;
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
