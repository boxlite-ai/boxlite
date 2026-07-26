"""Unit tests for the hosted SSH certificate binding (no VM required).

These drive the real Rust binding against a local stub of the hosted REST API,
so the certificate JSON fixture, the request the SDK sends, the generated key
pair and the redaction guarantees are all exercised end to end.

The fixture below is the shared cross-SDK shape from
``openapi/box.openapi.yaml`` (``SshCertificateCredential``).
"""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

import boxlite

_NATIVE_AVAILABLE = hasattr(boxlite, "Boxlite")

pytestmark = pytest.mark.skipif(
    not _NATIVE_AVAILABLE, reason="native Rust extension not available"
)

BOX_ID = "box-1"

CERTIFICATE_FIXTURE = {
    "id": "sshcred-1",
    "box_id": BOX_ID,
    "certificate": "ssh-ed25519-cert-v01@openssh.com AAAACERT",
    "public_key": "ssh-ed25519 AAAAPUB",
    "fingerprint": "SHA256:kEyF1nGeRpRiNt",
    "serial": "42",
    "ca_key_id": "ca-2026-07",
    "valid_after": "2026-07-25T12:00:00Z",
    "expires_at": "2026-07-25T12:05:00Z",
    "revoked_at": None,
    "host": "22-d-abc.direct.example.com",
    "port": 22,
    "ssh_command": "ssh -i id -o CertificateFile=id-cert.pub root@22-d-abc.direct.example.com",
    "proxy_command": "proxytunnel -p gateway.example.com:443",
    "known_hosts": "[22-d-abc.direct.example.com]:22 ssh-ed25519 AAAAHOST",
    "created_at": "2026-07-25T12:00:00Z",
    "updated_at": "2026-07-25T12:00:00Z",
}

BOX_FIXTURE = {
    "box_id": BOX_ID,
    "name": "demo",
    "status": "running",
    "created_at": "2026-07-25T11:59:00Z",
    "updated_at": "2026-07-25T11:59:30Z",
    "pid": None,
    "image": "alpine:latest",
    "cpus": 1,
    "memory_mib": 512,
    "labels": {},
}

CERTIFICATES_PATH = f"/v1/boxes/{BOX_ID}/ssh-access/certificates"


class _StubHostedApi:
    """Minimal stand-in for the hosted REST API's certificate endpoints."""

    def __init__(self) -> None:
        self.requests: list[dict] = []
        # Mutable so a test can vary one field of the shared fixture.
        self.certificate = dict(CERTIFICATE_FIXTURE)
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args) -> None:  # keep pytest output clean
                pass

            def _record(self, body: str | None = None) -> None:
                stub.requests.append(
                    {
                        "method": self.command,
                        "path": self.path,
                        "body": json.loads(body) if body else None,
                    }
                )

            def _respond(self, status: int, payload: dict | None) -> None:
                encoded = b"" if payload is None else json.dumps(payload).encode()
                self.send_response(status)
                if encoded:
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(encoded)))
                self.end_headers()
                if encoded:
                    self.wfile.write(encoded)

            def do_GET(self) -> None:
                self._record()
                if self.path == f"/v1/boxes/{BOX_ID}":
                    self._respond(200, BOX_FIXTURE)
                elif self.path.startswith(CERTIFICATES_PATH):
                    self._respond(200, {"certificates": [stub.certificate]})
                else:
                    self._respond(404, {"error": {"message": "not found"}})

            def do_POST(self) -> None:
                length = int(self.headers.get("Content-Length", 0))
                self._record(self.rfile.read(length).decode() if length else None)
                if self.path.startswith(CERTIFICATES_PATH):
                    self._respond(201, stub.certificate)
                else:
                    self._respond(404, {"error": {"message": "not found"}})

            def do_DELETE(self) -> None:
                self._record()
                self._respond(204, None)

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def __enter__(self) -> _StubHostedApi:  # noqa: PYI034 - typing.Self needs 3.11+; project supports 3.10+
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=5)

    @property
    def url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def only_request(self, method: str, path_prefix: str) -> dict:
        matches = [
            r
            for r in self.requests
            if r["method"] == method and r["path"].startswith(path_prefix)
        ]
        assert len(matches) == 1, f"expected 1 {method} {path_prefix}, got {matches}"
        return matches[0]


@pytest.fixture()
def hosted_api():
    with _StubHostedApi() as stub:
        yield stub


@pytest.fixture()
def hosted_box(hosted_api):
    runtime = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(url=hosted_api.url))
    yield runtime, hosted_api


async def _get_box(runtime):
    box = await runtime.get(BOX_ID)
    assert box is not None
    return box


class TestExports:
    def test_certificate_types_are_re_exported(self):
        for name in (
            "SshCertificateHandle",
            "SshCertificateCredential",
            "SshCredentialBundle",
        ):
            assert name in boxlite.__all__, f"{name} missing from __all__"
            assert getattr(boxlite, name) is not None

    def test_box_exposes_the_handle_as_an_attribute(self):
        assert hasattr(boxlite.Box, "ssh_certificates")

    @pytest.mark.skipif(
        not hasattr(boxlite, "SyncSshCertificateHandle"),
        reason="greenlet not installed",
    )
    def test_sync_mirror_exposes_the_same_methods(self):
        for name in ("create", "list", "revoke", "issue"):
            assert callable(getattr(boxlite.SyncSshCertificateHandle, name))


@pytest.mark.asyncio
class TestCertificateOperations:
    async def test_create_parses_the_shared_fixture(self, hosted_box):
        runtime, api = hosted_box
        box = await _get_box(runtime)

        credential = await box.ssh_certificates.create("ssh-ed25519 AAAAPUB", 15)

        assert credential.id == CERTIFICATE_FIXTURE["id"]
        assert credential.box_id == CERTIFICATE_FIXTURE["box_id"]
        assert credential.certificate == CERTIFICATE_FIXTURE["certificate"]
        assert credential.public_key == CERTIFICATE_FIXTURE["public_key"]
        assert credential.fingerprint == CERTIFICATE_FIXTURE["fingerprint"]
        # The wire carries a decimal string; Python gets an exact int.
        assert credential.serial == 42
        assert credential.ca_key_id == CERTIFICATE_FIXTURE["ca_key_id"]
        assert credential.valid_after == CERTIFICATE_FIXTURE["valid_after"]
        assert credential.expires_at == CERTIFICATE_FIXTURE["expires_at"]
        assert credential.revoked_at is None
        assert credential.host == CERTIFICATE_FIXTURE["host"]
        assert credential.port == CERTIFICATE_FIXTURE["port"]
        assert credential.ssh_command == CERTIFICATE_FIXTURE["ssh_command"]
        assert credential.proxy_command == CERTIFICATE_FIXTURE["proxy_command"]
        assert credential.known_hosts == CERTIFICATE_FIXTURE["known_hosts"]
        assert credential.created_at == CERTIFICATE_FIXTURE["created_at"]
        assert credential.updated_at == CERTIFICATE_FIXTURE["updated_at"]

        request = api.only_request("POST", CERTIFICATES_PATH)
        assert request["body"] == {"public_key": "ssh-ed25519 AAAAPUB"}
        assert "expiresInMinutes=15" in request["path"]

    async def test_create_without_ttl_leaves_the_policy_default(self, hosted_box):
        runtime, api = hosted_box
        box = await _get_box(runtime)

        await box.ssh_certificates.create("ssh-ed25519 AAAAPUB")

        assert (
            "expiresInMinutes"
            not in api.only_request("POST", CERTIFICATES_PATH)["path"]
        )

    async def test_serial_above_2_53_survives_exactly(self, hosted_box):
        """The wire encodes serial as a string so uint64 values stay exact."""
        runtime, api = hosted_box
        huge = 18446744073709551615  # u64::MAX
        api.certificate = {**CERTIFICATE_FIXTURE, "serial": str(huge)}
        box = await _get_box(runtime)

        credential = await box.ssh_certificates.create("ssh-ed25519 AAAAPUB")

        assert credential.serial == huge

    async def test_a_revoked_credential_carries_its_revocation_timestamp(
        self, hosted_box
    ):
        runtime, api = hosted_box
        api.certificate = {**CERTIFICATE_FIXTURE, "revoked_at": "2026-07-25T12:03:00Z"}
        box = await _get_box(runtime)

        credential = await box.ssh_certificates.create("ssh-ed25519 AAAAPUB")

        assert credential.revoked_at == "2026-07-25T12:03:00Z"

    async def test_list_returns_public_metadata(self, hosted_box):
        runtime, _api = hosted_box
        box = await _get_box(runtime)

        credentials = await box.ssh_certificates.list()

        assert [c.id for c in credentials] == [CERTIFICATE_FIXTURE["id"]]
        assert credentials[0].fingerprint == CERTIFICATE_FIXTURE["fingerprint"]

    async def test_revoke_targets_the_credential_id(self, hosted_box):
        runtime, api = hosted_box
        box = await _get_box(runtime)

        await box.ssh_certificates.revoke("sshcred-1")

        assert api.only_request("DELETE", CERTIFICATES_PATH)["path"] == (
            f"{CERTIFICATES_PATH}/sshcred-1"
        )

    async def test_issue_sends_only_a_locally_generated_public_key(self, hosted_box):
        runtime, api = hosted_box
        box = await _get_box(runtime)

        bundle = await box.ssh_certificates.issue()

        body = api.only_request("POST", CERTIFICATES_PATH)["body"]
        assert set(body) == {"public_key"}
        assert body["public_key"].startswith("ssh-ed25519 ")
        assert bundle.expose_private_key().startswith(
            "-----BEGIN OPENSSH PRIVATE KEY-----"
        )
        assert bundle.credential.id == CERTIFICATE_FIXTURE["id"]

    async def test_each_issue_generates_a_distinct_key(self, hosted_box):
        runtime, _api = hosted_box
        box = await _get_box(runtime)

        first = await box.ssh_certificates.issue()
        second = await box.ssh_certificates.issue()

        assert first.expose_private_key() != second.expose_private_key()


@pytest.mark.asyncio
class TestPrivateKeyRedaction:
    async def test_bundle_repr_and_str_hide_the_private_key(self, hosted_box):
        runtime, _api = hosted_box
        box = await _get_box(runtime)

        bundle = await box.ssh_certificates.issue()
        secret = bundle.expose_private_key()
        # The key body without the PEM banner — the part that must never leak.
        secret_body = secret.splitlines()[1]

        for rendered in (repr(bundle), str(bundle), f"{bundle}"):
            assert secret not in rendered
            assert secret_body not in rendered
            assert "[REDACTED]" in rendered
            # Redaction is targeted: public metadata stays visible.
            assert CERTIFICATE_FIXTURE["id"] in rendered

    async def test_credential_has_no_private_key_attribute(self, hosted_box):
        runtime, _api = hosted_box
        box = await _get_box(runtime)

        credential = (await box.ssh_certificates.issue()).credential

        assert not hasattr(credential, "private_key")
        assert "PRIVATE KEY" not in repr(credential)
        assert "PRIVATE KEY" not in str(credential)


@pytest.mark.asyncio
@pytest.mark.skipif(shutil.which("ssh-keygen") is None, reason="ssh-keygen not found")
async def test_generated_key_is_a_real_openssh_key(hosted_box):
    """`ssh-keygen -y` must derive exactly the public key the SDK submitted."""
    runtime, api = hosted_box
    box = await _get_box(runtime)

    bundle = await box.ssh_certificates.issue()
    submitted = api.only_request("POST", CERTIFICATES_PATH)["body"]["public_key"]

    with tempfile.TemporaryDirectory() as workdir:
        key_path = Path(workdir) / "id_ed25519"
        key_path.write_text(bundle.expose_private_key())
        key_path.chmod(0o600)
        # Off the event loop: ruff's ASYNC221 rightly rejects a blocking
        # subprocess call inside a coroutine.
        completed = await asyncio.to_thread(
            subprocess.run,
            ["ssh-keygen", "-y", "-f", str(key_path)],
            capture_output=True,
            text=True,
            check=True,
        )
        derived = completed.stdout.strip()

    # `ssh-keygen -y` prints "<type> <base64>"; the SDK may append a comment.
    assert derived.split()[:2] == submitted.split()[:2]
    assert derived.startswith("ssh-ed25519 ")
