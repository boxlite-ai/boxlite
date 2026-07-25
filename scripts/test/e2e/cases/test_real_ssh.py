"""End-to-end coverage for real SSH access (design, external source of truth
in the boxlite_integration_test repo, not checked into this repository:
https://github.com/nieyy/boxlite_integration_test/blob/main/docs/designs/2026-07-23-boxlite-direct-tunnel-real-ssh-design-zh.md,
Phase 4).

Exercises the full chain the design requires: create a box-scoped app grant
-> locally generate an ephemeral Ed25519 keypair and create a temporary SSH
credential from its public key -> connect with the *standard* OpenSSH client
through the existing direct-tunnel `ProxyCommand` (no custom protocol, no
`StrictHostKeyChecking=no` -- the reported host key is written to a real
`known_hosts` file and verified) -> exec, interactive PTY + resize, SFTP
upload/download/rename/delete -> stop/start (host identity must stay stable)
-> revoke (subsequent connection attempts must be rejected) -> destroy.

Requires the `proxytunnel` binary on the test host in addition to this
suite's existing `ssh`/`sftp`/`ssh-keygen` prerequisites -- see
scripts/test/e2e/README.md. Like every other case in this directory, this
talks to the real API -> Runner -> VM chain; there is no mocked or
in-process path here to fall back to.
"""
from __future__ import annotations

import json
import os
import pty
import select
import shutil
import struct
import subprocess
import termios
import time
from pathlib import Path

import boxlite
import pytest

from conftest import DEFAULT_IMAGE
from e2e_auth import request_json

pytestmark = pytest.mark.e2e

SSH_CONNECT_TIMEOUT = int(os.environ.get("BOXLITE_E2E_SSH_TIMEOUT", "20"))


def _require_binary(name: str) -> str:
    path = shutil.which(name)
    if not path:
        pytest.skip(f"{name!r} not found on PATH; required for real-SSH E2E")
    return path


@pytest.fixture(scope="module", autouse=True)
def _require_ssh_toolchain():
    for binary in ("ssh", "sftp", "ssh-keygen", "proxytunnel"):
        _require_binary(binary)


def _api_call(method: str, path: str, body: dict | None = None) -> tuple[int, dict | None]:
    return request_json(method, path, body)


def _create_access_grant(box_id: str, *, expires_in_seconds: int = 3600) -> dict:
    status, body = _api_call(
        "POST",
        f"/box/{box_id}/access-grants",
        {"scopes": ["ssh"], "expiresInSeconds": expires_in_seconds},
    )
    assert status == 201, f"create access grant failed: {status} {body}"
    assert body and body.get("appKey"), "access grant response missing one-time appKey"
    return body


def _revoke_access_grant(box_id: str, grant_id: str) -> None:
    status, _ = _api_call("DELETE", f"/box/{box_id}/access-grants/{grant_id}")
    assert status == 200, f"revoke access grant failed: {status}"


def _generate_ed25519_keypair(directory: Path, comment: str) -> tuple[Path, str]:
    """Generates a real OpenSSH keypair via `ssh-keygen` (the same trusted
    tool the design's "local key generation" requirement is meant to be
    equivalent to) and returns (private_key_path, public_key_line). The
    private key never leaves this test process; only the public key line is
    ever sent to the API."""
    key_path = directory / "id_ed25519"
    subprocess.run(
        ["ssh-keygen", "-t", "ed25519", "-N", "", "-C", comment, "-f", str(key_path)],
        check=True,
        capture_output=True,
    )
    key_path.chmod(0o600)
    public_key_line = (directory / "id_ed25519.pub").read_text().strip()
    return key_path, public_key_line


def _create_temporary_credential(
    box_id: str, grant_id: str, public_key_line: str, *, expires_in_seconds: int = 300
) -> dict:
    status, body = _api_call(
        "POST",
        f"/box/{box_id}/ssh-access",
        {"grantId": grant_id, "publicKey": public_key_line, "expiresInSeconds": expires_in_seconds},
    )
    assert status == 201, f"create temporary SSH credential failed: {status} {body}"
    for field in ("id", "endpoint", "proxyCommand", "hostKeyFingerprint", "knownHostsEntry", "sshCommand"):
        assert body and body.get(field), f"credential response missing {field!r}: {body}"
    return body


def _revoke_temporary_credential(box_id: str, credential_id: str) -> None:
    status, _ = _api_call("DELETE", f"/box/{box_id}/ssh-access/{credential_id}")
    assert status == 200, f"revoke temporary SSH credential failed: {status}"


def _write_known_hosts(directory: Path, known_hosts_entry: str) -> Path:
    path = directory / "known_hosts"
    path.write_text(known_hosts_entry.strip() + "\n")
    return path


def _ssh_base_args(credential: dict, private_key_path: Path, known_hosts_path: Path) -> list[str]:
    # Real OpenSSH trust material end to end: the host key reported by the
    # API (which the guest itself reported over the authenticated control
    # path) is what UserKnownHostsFile pins -- StrictHostKeyChecking stays
    # at its secure default, per the design's explicit prohibition on
    # disabling it.
    return [
        "ssh",
        "-i", str(private_key_path),
        "-o", f"UserKnownHostsFile={known_hosts_path}",
        "-o", "StrictHostKeyChecking=yes",
        "-o", "BatchMode=yes",
        "-o", f"ConnectTimeout={SSH_CONNECT_TIMEOUT}",
        "-o", f"ProxyCommand={credential['proxyCommand']}",
        f"root@{credential['endpoint']}",
    ]


def _ssh_exec(credential: dict, private_key_path: Path, known_hosts_path: Path, command: str) -> subprocess.CompletedProcess:
    args = _ssh_base_args(credential, private_key_path, known_hosts_path) + [command]
    return subprocess.run(args, capture_output=True, text=True, timeout=SSH_CONNECT_TIMEOUT + 10)


def _sftp_batch(credential: dict, private_key_path: Path, known_hosts_path: Path, batch: str) -> subprocess.CompletedProcess:
    args = [
        "sftp",
        "-i", str(private_key_path),
        "-o", f"UserKnownHostsFile={known_hosts_path}",
        "-o", "StrictHostKeyChecking=yes",
        "-o", "BatchMode=yes",
        "-o", f"ConnectTimeout={SSH_CONNECT_TIMEOUT}",
        "-o", f"ProxyCommand={credential['proxyCommand']}",
        "-b", "-",
        f"root@{credential['endpoint']}",
    ]
    return subprocess.run(args, input=batch, capture_output=True, text=True, timeout=SSH_CONNECT_TIMEOUT + 10)


@pytest.mark.asyncio
async def test_real_ssh_full_lifecycle(rt, tmp_path):
    """Create app grant -> SDK-created temporary credential -> SSH exec ->
    interactive PTY/resize -> SFTP upload/download/rename/delete ->
    stop/start -> revoke -> reconnect rejected -> destroy.

    One long scenario rather than split tests: every step depends on state
    (the credential, the box's running state) built up by the previous one,
    and splitting would just re-pay the box-boot cost per step for no
    isolation benefit -- nothing here is independently repeatable.
    """
    box = await rt.create(boxlite.BoxOptions(image=DEFAULT_IMAGE, auto_remove=False))
    box_id = box.id
    grant_id = None
    credential_id = None

    try:
        # ── create app grant + SDK-created temporary credential ──────────
        grant = _create_access_grant(box_id)
        grant_id = grant["id"]

        private_key_path, public_key_line = _generate_ed25519_keypair(tmp_path, "e2e-real-ssh")
        credential = _create_temporary_credential(box_id, grant_id, public_key_line)
        credential_id = credential["id"]
        known_hosts_path = _write_known_hosts(tmp_path, credential["knownHostsEntry"])
        first_host_fingerprint = credential["hostKeyFingerprint"]

        # ── SSH exec ───────────────────────────────────────────────────
        result = _ssh_exec(credential, private_key_path, known_hosts_path, "echo real-ssh-ok")
        assert result.returncode == 0, f"ssh exec failed: {result.stderr}"
        assert "real-ssh-ok" in result.stdout

        # ── interactive PTY + resize ──────────────────────────────────
        _assert_pty_resize_reaches_shell(credential, private_key_path, known_hosts_path)

        # ── SFTP upload / download / rename / delete ──────────────────
        local_upload = tmp_path / "upload.txt"
        local_upload.write_text("sftp-roundtrip-payload\n")
        local_download = tmp_path / "download.txt"

        batch = (
            "put {upload} /root/e2e-sftp.txt\n"
            "rename /root/e2e-sftp.txt /root/e2e-sftp-renamed.txt\n"
            "get /root/e2e-sftp-renamed.txt {download}\n"
            "rm /root/e2e-sftp-renamed.txt\n"
        ).format(upload=local_upload, download=local_download)
        sftp_result = _sftp_batch(credential, private_key_path, known_hosts_path, batch)
        assert sftp_result.returncode == 0, f"sftp batch failed: {sftp_result.stderr}"
        assert local_download.read_text() == local_upload.read_text()

        verify = _ssh_exec(credential, private_key_path, known_hosts_path, "test -e /root/e2e-sftp-renamed.txt && echo present || echo gone")
        assert "gone" in verify.stdout, "sftp rm did not remove the remote file"

        # ── stop / start: host identity must stay stable ──────────────
        await box.stop()
        await box.start()
        _wait_for_box_state(box_id, "started", timeout=60)

        result = _ssh_exec(credential, private_key_path, known_hosts_path, "echo after-restart-ok")
        assert result.returncode == 0, f"ssh exec after restart failed: {result.stderr}"
        assert "after-restart-ok" in result.stdout

        status_grant = _get_credential_status(box_id, credential_id)
        assert status_grant["publicKeyFingerprint"] == credential["publicKeyFingerprint"]
        # The design requires stop/start to read the SAME guest host key;
        # an unexplained change must degrade, not silently rotate.
        post_restart_result = _ssh_exec(credential, private_key_path, known_hosts_path, "true")
        assert post_restart_result.returncode == 0, (
            "host key changed across a normal stop/start -- known_hosts pinned to "
            f"{first_host_fingerprint} must still be accepted"
        )

        # ── revoke -> reconnect rejected ───────────────────────────────
        _revoke_temporary_credential(box_id, credential_id)
        credential_id = None  # already revoked; skip in finally

        rejected = _ssh_exec(credential, private_key_path, known_hosts_path, "echo should-not-run")
        assert rejected.returncode != 0, "SSH connected with a revoked credential"
        assert "should-not-run" not in rejected.stdout

    finally:
        if credential_id:
            try:
                _revoke_temporary_credential(box_id, credential_id)
            except Exception:
                pass
        if grant_id:
            try:
                _revoke_access_grant(box_id, grant_id)
            except Exception:
                pass
        # ── destroy ─────────────────────────────────────────────────────
        try:
            await rt.remove(box_id, force=True)
        except Exception:
            pass


def _get_credential_status(box_id: str, credential_id: str) -> dict:
    status, body = _api_call("GET", f"/box/{box_id}/ssh-access")
    assert status == 200, f"list temporary SSH credentials failed: {status} {body}"
    matches = [c for c in (body or []) if c["id"] == credential_id]
    assert matches, f"credential {credential_id} missing from list response"
    return matches[0]


def _wait_for_box_state(box_id: str, expected_state: str, *, timeout: float) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        status, body = _api_call("GET", f"/box/{box_id}")
        if status == 200 and body and body.get("state") == expected_state:
            return
        time.sleep(1)
    pytest.fail(f"box {box_id} did not reach state {expected_state!r} within {timeout}s")


def _assert_pty_resize_reaches_shell(credential: dict, private_key_path: Path, known_hosts_path: Path) -> None:
    """Allocates a real pseudo-terminal, drives an interactive `ssh -tt`
    session through it, and proves a window-size change is delivered to the
    remote shell -- the same signal a real terminal client relies on."""
    args = ["ssh", "-tt"] + _ssh_base_args(credential, private_key_path, known_hosts_path)[1:]

    master_fd, slave_fd = pty.openpty()
    _set_window_size(master_fd, rows=24, cols=80)

    proc = subprocess.Popen(
        args,
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        close_fds=True,
    )
    os.close(slave_fd)

    try:
        _send(master_fd, "stty size\n")
        first = _read_until_contains(master_fd, "24 80", timeout=SSH_CONNECT_TIMEOUT + 10)
        assert "24 80" in first, f"initial PTY size not observed by the remote shell: {first!r}"

        _set_window_size(master_fd, rows=40, cols=100)
        proc.send_signal(__import__("signal").SIGWINCH)
        _send(master_fd, "stty size\n")
        second = _read_until_contains(master_fd, "40 100", timeout=SSH_CONNECT_TIMEOUT)
        assert "40 100" in second, f"resized PTY dimensions not observed by the remote shell: {second!r}"

        _send(master_fd, "exit\n")
        proc.wait(timeout=SSH_CONNECT_TIMEOUT)
    finally:
        os.close(master_fd)
        if proc.poll() is None:
            proc.kill()


def _set_window_size(fd: int, *, rows: int, cols: int) -> None:
    termios.tcsetwinsize(fd, (rows, cols, 0, 0))


def _send(fd: int, data: str) -> None:
    os.write(fd, data.encode())


def _read_until_contains(fd: int, needle: str, *, timeout: float) -> str:
    deadline = time.time() + timeout
    buf = b""
    while time.time() < deadline:
        remaining = deadline - time.time()
        ready, _, _ = select.select([fd], [], [], max(0, remaining))
        if not ready:
            continue
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
        if needle.encode() in buf:
            break
    return buf.decode(errors="replace")
