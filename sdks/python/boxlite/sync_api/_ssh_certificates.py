"""SyncSshCertificateHandle - synchronous SSH certificate operations for a box."""

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..boxlite import SshCertificateCredential, SshCredentialBundle
    from ._box import SyncBox

__all__ = ["SyncSshCertificateHandle"]


class SyncSshCertificateHandle:
    """Synchronous wrapper for a box's SSH certificate handle.

    Hosted runtimes only; the embedded runtime raises ``BoxliteError``.
    """

    def __init__(self, box: "SyncBox") -> None:
        self._owner = box

    def create(
        self, public_key: str, ttl_minutes: int | None = None
    ) -> "SshCertificateCredential":
        """Sign a certificate for a public key the caller already holds."""
        return self._owner._sync(
            self._owner._box.ssh_certificates.create(public_key, ttl_minutes)
        )

    def list(self) -> list["SshCertificateCredential"]:
        """Return public metadata for this box's credentials."""
        return self._owner._sync(self._owner._box.ssh_certificates.list())

    def revoke(self, credential_id: str) -> None:
        """Revoke one credential by ID."""
        self._owner._sync(self._owner._box.ssh_certificates.revoke(credential_id))

    def issue(self, ttl_minutes: int | None = None) -> "SshCredentialBundle":
        """Generate an Ed25519 key pair locally and get a certificate for it.

        Only the public half is sent. Certificates are short-lived, so issue
        one immediately before connecting rather than ahead of time.
        """
        return self._owner._sync(self._owner._box.ssh_certificates.issue(ttl_minutes))
