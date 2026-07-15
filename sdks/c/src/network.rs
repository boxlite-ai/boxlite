//! Network operations for the BoxLite C SDK.

use std::net::SocketAddr;
use std::os::fd::IntoRawFd;
use std::ptr;
use std::sync::Arc;

use tokio::runtime::Runtime as TokioRuntime;

use boxlite::BoxliteError;
use boxlite::litebox::{BoxEndpoint, NetworkHandle as CoreNetworkHandle};

use crate::error::{BoxliteErrorCode, null_pointer_error, write_error};
use crate::{CBoxHandle, CBoxNetworkHandle, CBoxliteError};

/// Opaque handle for network operations on a box.
pub struct BoxNetworkHandle {
    handle: CoreNetworkHandle,
    tokio_rt: Arc<TokioRuntime>,
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_network(
    handle: *mut CBoxHandle,
    out_network: *mut *mut CBoxNetworkHandle,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    box_network(handle, out_network, out_error)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_network_free(network: *mut CBoxNetworkHandle) {
    if !network.is_null() {
        unsafe { drop(Box::from_raw(network)) };
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn boxlite_box_network_tunnel(
    network: *mut CBoxNetworkHandle,
    port: u16,
    out_fd: *mut i32,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    network_tunnel(network, port, out_fd, out_error)
}

unsafe fn box_network(
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

unsafe fn network_tunnel(
    network: *mut BoxNetworkHandle,
    port: u16,
    out_fd: *mut i32,
    out_error: *mut CBoxliteError,
) -> BoxliteErrorCode {
    unsafe {
        if network.is_null() {
            write_error(out_error, null_pointer_error("network"));
            return BoxliteErrorCode::InvalidArgument;
        }
        if out_fd.is_null() {
            write_error(out_error, null_pointer_error("out_fd"));
            return BoxliteErrorCode::InvalidArgument;
        }
        *out_fd = -1;

        if port == 0 {
            write_error(
                out_error,
                BoxliteError::InvalidArgument("tunnel port must be non-zero".into()),
            );
            return BoxliteErrorCode::InvalidArgument;
        }

        let target: SocketAddr =
            match format!("{}:{port}", boxlite::net::constants::GUEST_IP).parse() {
                Ok(target) => target,
                Err(e) => {
                    write_error(
                        out_error,
                        BoxliteError::Internal(format!("invalid BoxLite guest IP constant: {e}")),
                    );
                    return BoxliteErrorCode::Internal;
                }
            };

        let network_ref = &*network;
        match network_ref
            .tokio_rt
            .block_on(async { network_ref.handle.tunnel(target).await?.endpoint().await })
        {
            Ok(BoxEndpoint::Fd(fd)) => {
                *out_fd = fd.into_raw_fd();
                BoxliteErrorCode::Ok
            }
            Ok(BoxEndpoint::Url(_)) => {
                write_error(
                    out_error,
                    BoxliteError::Unsupported(
                        "box network tunnel transport cannot be exported as fd".into(),
                    ),
                );
                BoxliteErrorCode::Unsupported
            }
            Err(e) => {
                write_error(out_error, e);
                BoxliteErrorCode::Network
            }
        }
    }
}
