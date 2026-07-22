//! Network operations for the BoxLite C SDK.

use std::ffi::CString;
use std::net::SocketAddr;
use std::os::fd::{BorrowedFd, IntoRawFd};
use std::os::raw::c_char;
use std::ptr;
use std::sync::Arc;

use tokio::runtime::Runtime as TokioRuntime;

use boxlite::litebox::{
    BoxEndpoint, BoxTunnel as CoreBoxTunnel, NetworkHandle as CoreNetworkHandle,
};
use boxlite::{BoxConnection, BoxliteError};

use crate::error::{BoxliteErrorCode, error_to_code, null_pointer_error, write_error};
use crate::{CBoxHandle, CBoxNetworkHandle, CBoxTunnelHandle, CBoxliteError};

async fn connection_fd(
    mut connection: Box<dyn BoxConnection>,
) -> Result<std::os::fd::OwnedFd, BoxliteError> {
    let (sdk, mut bridge) = tokio::net::UnixStream::pair()
        .map_err(|error| BoxliteError::Network(format!("create SDK socket bridge: {error}")))?;
    tokio::spawn(async move {
        let _ = tokio::io::copy_bidirectional(&mut connection, &mut bridge).await;
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

/// The kind of endpoint exposed by a box tunnel.
#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoxliteEndpointType {
    BoxliteEndpointTypeUri = 0,
    BoxliteEndpointTypeFileDescriptor = 1,
}

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

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_network_free(network: *mut CBoxNetworkHandle) {
    if !network.is_null() {
        unsafe { drop(Box::from_raw(network)) };
    }
}

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

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_tunnel_free(tunnel: *mut CBoxTunnelHandle) {
    if !tunnel.is_null() {
        unsafe { drop(Box::from_raw(tunnel)) };
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_tunnel_endpoint(
    tunnel: *mut CBoxTunnelHandle,
    out_type: *mut BoxliteEndpointType,
    out_uri: *mut *mut c_char,
    out_fd: *mut i32,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if tunnel.is_null() {
            write_error(out_error, null_pointer_error("tunnel"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_type.is_null() {
            write_error(out_error, null_pointer_error("out_type"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_uri.is_null() {
            write_error(out_error, null_pointer_error("out_uri"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_fd.is_null() {
            write_error(out_error, null_pointer_error("out_fd"));
            return BoxliteErrorCode::InvalidArgument;
        }
        *out_type = BoxliteEndpointType::BoxliteEndpointTypeUri;
        *out_uri = ptr::null_mut();
        *out_fd = -1;

        let tunnel_ref = &*tunnel;
        match tunnel_ref.handle.as_ref() {
            Some(handle) => {
                match handle.endpoint() {
                    BoxEndpoint::Uri(uri) => {
                        let uri = match CString::new(uri) {
                            Ok(uri) => uri,
                            Err(_) => {
                                write_error(
                                    out_error,
                                    BoxliteError::Internal(
                                        "tunnel endpoint contains a NUL byte".into(),
                                    ),
                                );
                                return BoxliteErrorCode::Internal;
                            }
                        };
                        *out_type = BoxliteEndpointType::BoxliteEndpointTypeUri;
                        *out_uri = uri.into_raw();
                    }
                    BoxEndpoint::FileDescriptor(fd) => {
                        *out_type = BoxliteEndpointType::BoxliteEndpointTypeFileDescriptor;
                        *out_fd = fd;
                    }
                }
                BoxliteErrorCode::Ok
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
        if let BoxEndpoint::FileDescriptor(fd) = handle.endpoint() {
            // The local descriptor is already the tunnel. Duplicate it for the
            // caller instead of inserting another socket pair and copy task.
            let fd = BorrowedFd::borrow_raw(fd)
                .try_clone_to_owned()
                .map_err(|error| {
                    BoxliteError::Network(format!("duplicate local tunnel descriptor: {error}"))
                });
            drop(handle);
            return match fd {
                Ok(fd) => {
                    *out_fd = fd.into_raw_fd();
                    BoxliteErrorCode::Ok
                }
                Err(error) => {
                    let code = error_to_code(&error);
                    write_error(out_error, error);
                    code
                }
            };
        }

        match handle.connect() {
            Ok(connection) => match tunnel_ref.tokio_rt.block_on(connection_fd(connection)) {
                Ok(fd) => {
                    *out_fd = fd.into_raw_fd();
                    BoxliteErrorCode::Ok
                }
                Err(error) => {
                    let code = error_to_code(&error);
                    write_error(out_error, error);
                    code
                }
            },
            Err(error) => {
                let code = error_to_code(&error);
                write_error(out_error, error);
                code
            }
        }
    }
}
