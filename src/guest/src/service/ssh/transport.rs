//! Host-only guest SSH ingress over vsock.

use std::io;
use tokio_vsock::{VsockAddr, VsockListener, VsockStream, VMADDR_CID_ANY, VMADDR_CID_HOST};

pub(super) struct Listener(VsockListener);

impl Listener {
    pub(super) fn bind() -> io::Result<Self> {
        VsockListener::bind(VsockAddr::new(
            VMADDR_CID_ANY,
            boxlite_shared::constants::network::GUEST_SSH_PORT,
        ))
        .map(Self)
    }

    pub(super) async fn accept(&self) -> io::Result<Option<(VsockStream, String)>> {
        let (socket, peer) = self.0.accept().await?;
        if let Err(error) = require_host_cid(peer.cid()) {
            tracing::debug!(%error, cid = peer.cid(), "Rejected SSH vsock peer");
            return Ok(None);
        }
        Ok(Some((
            socket,
            format!("vsock://{}:{}", peer.cid(), peer.port()),
        )))
    }
}

fn require_host_cid(cid: u32) -> io::Result<()> {
    if cid != VMADDR_CID_HOST {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "SSH vsock peer is not the host",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_vsock_rejects_local_guest_and_wildcard_cids() {
        require_host_cid(VMADDR_CID_HOST).unwrap();
        for cid in [0, 1, 3, 4, VMADDR_CID_ANY] {
            assert_eq!(
                require_host_cid(cid).unwrap_err().kind(),
                io::ErrorKind::PermissionDenied
            );
        }
    }
}
