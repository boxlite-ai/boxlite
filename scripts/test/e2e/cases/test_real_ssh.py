"""End-to-end CA-based real SSH over the existing direct tunnel.

Covers the Phase 5 acceptance path from the design:

    create box with trust -> wait readiness -> issue just in time -> SSH exec
    -> PTY/resize -> SFTP -> second credential -> revoke one -> expiry
    rejection -> stop/start retains trust -> destroy

plus the isolation cases reachable through the public API: cross-box, wrong
login user, a raw key with no certificate, an untrusted CA, and expiry.

Cross-organization and not-yet-valid certificates are NOT covered here: this
API will not mint either, so they cannot be produced end to end. Both are
covered against the real verifier by the guest unit suite
(`src/guest/src/service/ssh/ca.rs`), which signs such certificates directly.

Transport is deliberately unchanged: every connection goes through the
existing direct-tunnel hostname and `ProxyCommand` that the API returns. These
tests never construct a hostname themselves.

Host identity: `StrictHostKeyChecking=no` is never used. The API does not yet
return a populated `known_hosts` line (the guest persists a host key, but
nothing delivers it to the API), so these tests learn the key on first connect
with `accept-new` into a per-test file and then require it to stay unchanged —
which is what makes the stop/start persistence assertion meaningful. Once the
API populates `known_hosts`, switch `ssh_argv` to write it and use `yes`.

RUNNING THIS SUITE
------------------
It needs the full local stack (`make test:e2e:setup`), which `bootstrap.sh`
builds with apt + systemd — i.e. a Linux host. It also needs certificate
issuance enabled for the organization under test
(`SSH_CERTIFICATE_ISSUANCE_ENABLED=true`) and a box created with a CA trust
bundle, which in turn needs a provisioned organization CA signer.

Until that stack is actually stood up, the suite skips rather than passing
vacuously: a green run that silently exercised nothing would be worse than a
skip. `boxlite_ssh_e2e_ready()` is the single gate.
"""

from __future__ import annotations

import os
import shutil
import stat
import subprocess
import tempfile
import time
from pathlib import Path

import pytest

pytestmark = [pytest.mark.e2e, pytest.mark.ssh]


SSH_READY_ENV = "BOXLITE_E2E_SSH_ENABLED"


def boxlite_ssh_e2e_ready() -> tuple[bool, str]:
    """Whether the deployment under test can actually serve this suite.

    Kept explicit and boring: each precondition reports itself, so a skip
    message says which piece is missing instead of "something wasn't ready".
    """
    if os.environ.get(SSH_READY_ENV, "").lower() not in ("1", "true", "yes"):
        return False, (
            f"{SSH_READY_ENV} is not set. The deployment under test must have "
            "SSH certificate issuance enabled and boxes created with a CA "
            "trust bundle."
        )
    for tool in ("ssh", "sftp", "ssh-keygen"):
        if shutil.which(tool) is None:
            return False, f"{tool} is not installed on the test host"
    return True, ""


_ready, _reason = boxlite_ssh_e2e_ready()
pytestmark.append(pytest.mark.skipif(not _ready, reason=_reason))


# ─── helpers ────────────────────────────────────────────────────────────────

# Credential dirs created without an explicit base; each holds a private key,
# so they are removed at session end rather than left in /tmp.
_CREDENTIAL_DIRS: list[Path] = []


@pytest.fixture(scope="session", autouse=True)
def _cleanup_credential_dirs():
    yield
    for path in _CREDENTIAL_DIRS:
        shutil.rmtree(path, ignore_errors=True)


def write_credential_files(bundle, known_hosts_path: Path | None = None) -> tuple[Path, Path, Path]:
    """Materialize a credential bundle as the three files ssh(1) expects.

    OpenSSH refuses a private key whose permissions are too open, so the mode
    is set explicitly rather than left to the umask.

    The directory is tracked and removed by `_cleanup_credential_dirs` at
    session end — these files hold real private keys, so none may outlive the
    run.

    Pass `known_hosts_path` to reuse a host-key file across connections; that
    is how the stop/start test proves the fingerprint did not change.
    """
    tmp = Path(tempfile.mkdtemp(prefix="boxlite-ssh-e2e-"))
    _CREDENTIAL_DIRS.append(tmp)
    key = tmp / "id_ed25519"
    cert = tmp / "id_ed25519-cert.pub"
    known = known_hosts_path or (tmp / "known_hosts")

    key.write_text(bundle.private_key)
    key.chmod(stat.S_IRUSR | stat.S_IWUSR)
    cert.write_text(bundle.credential.certificate)
    # The API does not populate known_hosts yet; seed the file when it does, so
    # this flips to strict pinning without touching the tests.
    if bundle.credential.known_hosts and not known.exists():
        known.write_text(bundle.credential.known_hosts)
    known.touch(exist_ok=True)
    return key, cert, known


def ssh_argv(bundle, key: Path, cert: Path, known: Path, *command: str) -> list[str]:
    """Build an ssh(1) command line from API-provided endpoint metadata only.

    `proxy_command` and `host` come straight from the certificate response, so
    this exercises the deployed direct tunnel rather than a hostname this test
    invented.
    """
    credential = bundle.credential
    return [
        "ssh",
        "-i", str(key),
        "-o", f"CertificateFile={cert}",
        "-o", f"UserKnownHostsFile={known}",
        # Host identity is pinned, never bypassed. `accept-new` learns an
        # unknown key once and then refuses any change to it — unlike
        # `StrictHostKeyChecking=no`, which would silently accept a changed
        # key. Switch to `yes` once the API populates `known_hosts`.
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "IdentitiesOnly=yes",
        "-o", "BatchMode=yes",
        "-o", f"ProxyCommand={credential.proxy_command}",
        "-p", str(credential.port),
        f"root@{credential.host}",
        *command,
    ]


def run_ssh(bundle, *command: str, timeout: int = 60) -> subprocess.CompletedProcess:
    key, cert, known = write_credential_files(bundle)
    return subprocess.run(
        ssh_argv(bundle, key, cert, known, *command),
        capture_output=True,
        text=True,
        timeout=timeout,
    )


async def wait_for_ssh_ready(box, timeout: float = 120.0) -> None:
    """Block until the guest SSH listener accepts connections.

    Issues ONE certificate and reuses it for every probe. Minting one per poll
    would spend ~60 credentials per call at a 2s interval, blowing through both
    documented limits — `SSH_CERTIFICATE_ISSUE_RATE_LIMIT` (10/60s) and
    `SSH_CERTIFICATE_MAX_ACTIVE_PER_BOX` (10) — so the readiness helper itself
    would fail the run with TOO_MANY_ACTIVE_CREDENTIALS.

    One certificate is enough: the 5-minute default TTL comfortably outlives
    this 120s timeout. The probe is re-issued only if the wait somehow outruns
    the certificate.

    Note this deliberately issues BEFORE readiness, unlike the tests. That is
    the tradeoff for a readiness probe; real callers must issue after the box
    is ready so a short-lived certificate is not spent waiting on boot.
    """
    deadline = time.time() + timeout
    bundle = await box.ssh_certificates().issue()
    reissue_at = time.time() + 240.0
    last = None
    while time.time() < deadline:
        if time.time() > reissue_at:
            bundle = await box.ssh_certificates().issue()
            reissue_at = time.time() + 240.0
        result = run_ssh(bundle, "true", timeout=20)
        if result.returncode == 0:
            return
        last = result.stderr
        time.sleep(2.0)
    pytest.fail(f"guest SSH never became ready within {timeout}s; last error: {last}")


# ─── main acceptance path ───────────────────────────────────────────────────


async def test_issue_then_exec_over_the_direct_tunnel(box):
    await wait_for_ssh_ready(box)

    bundle = await box.ssh_certificates().issue()
    result = run_ssh(bundle, "echo", "hello-from-ssh")

    assert result.returncode == 0, result.stderr
    assert "hello-from-ssh" in result.stdout


async def test_exec_reports_the_remote_exit_status(box):
    await wait_for_ssh_ready(box)
    bundle = await box.ssh_certificates().issue()

    assert run_ssh(bundle, "exit", "7").returncode == 7


async def test_pty_allocation_and_window_size(box):
    await wait_for_ssh_ready(box)
    bundle = await box.ssh_certificates().issue()
    key, cert, known = write_credential_files(bundle)

    argv = ssh_argv(bundle, key, cert, known, "stty size")
    argv.insert(1, "-tt")  # force a PTY even without a local terminal
    result = subprocess.run(argv, capture_output=True, text=True, timeout=60)

    assert result.returncode == 0, result.stderr
    rows, cols = result.stdout.split()[:2]
    assert int(rows) > 0 and int(cols) > 0


async def test_sftp_round_trip(box, tmp_path):
    await wait_for_ssh_ready(box)
    bundle = await box.ssh_certificates().issue()
    key, cert, known = write_credential_files(bundle)
    credential = bundle.credential

    source = tmp_path / "upload.txt"
    source.write_text("sftp-payload")
    downloaded = tmp_path / "download.txt"

    batch = tmp_path / "batch"
    batch.write_text(f"put {source} /tmp/uploaded.txt\nget /tmp/uploaded.txt {downloaded}\n")

    result = subprocess.run(
        [
            "sftp",
            "-b", str(batch),
            "-i", str(key),
            "-o", f"CertificateFile={cert}",
            "-o", f"UserKnownHostsFile={known}",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "IdentitiesOnly=yes",
            "-o", "BatchMode=yes",
            "-o", f"ProxyCommand={credential.proxy_command}",
            "-P", str(credential.port),
            f"root@{credential.host}",
        ],
        capture_output=True,
        text=True,
        timeout=120,
    )

    assert result.returncode == 0, result.stderr
    assert downloaded.read_text() == "sftp-payload"


async def test_two_concurrent_credentials_then_revoke_one(box):
    await wait_for_ssh_ready(box)
    certificates = box.ssh_certificates()

    first = await certificates.issue()
    second = await certificates.issue()

    # Issuing the second must not have revoked the first.
    assert run_ssh(first, "true").returncode == 0
    assert run_ssh(second, "true").returncode == 0

    listed = await certificates.list()
    ids = {c.id for c in listed}
    assert {first.credential.id, second.credential.id} <= ids

    await certificates.revoke(first.credential.id)

    remaining = {c.id for c in await certificates.list()}
    assert first.credential.id not in remaining
    assert second.credential.id in remaining

    # The revoked credential's already-issued certificate stays usable until
    # it expires — this is the design's TTL-bounded revocation, stated
    # honestly rather than claimed as immediate.
    assert run_ssh(first, "true").returncode == 0
    assert run_ssh(second, "true").returncode == 0


async def test_expired_certificate_is_rejected(box):
    await wait_for_ssh_ready(box)

    bundle = await box.ssh_certificates().issue(ttl_minutes=1)
    assert run_ssh(bundle, "true").returncode == 0

    # `validBefore` is `issuedAt + ttl` with NO skew added — the skew allowance
    # is applied only to `validAfter` (ssh-certificate.service.ts) because the
    # design forbids extending `validBefore` to compensate for drift. So a
    # 1-minute certificate is expired by t+70s with ~10s of margin.
    time.sleep(70)
    assert run_ssh(bundle, "true").returncode != 0


async def test_stop_start_retains_the_same_trust_and_host_identity(box, tmp_path):
    await wait_for_ssh_ready(box)

    # One known_hosts file reused across the restart. The first connection
    # learns the host key; the second must match the key already pinned in it,
    # so a regenerated host key fails the connection rather than being silently
    # re-learned. Comparing the API's `known_hosts` field would prove nothing
    # while that field is unpopulated.
    known = tmp_path / "known_hosts"

    before = await box.ssh_certificates().issue()
    key, cert, _ = write_credential_files(before, known_hosts_path=known)
    assert (
        subprocess.run(
            ssh_argv(before, key, cert, known, "true"), capture_output=True, text=True, timeout=60
        ).returncode
        == 0
    )
    pinned = known.read_text()
    assert pinned.strip(), "first connection should have pinned a host key"

    await box.stop()
    await box.start()
    await wait_for_ssh_ready(box)

    after = await box.ssh_certificates().issue()
    key, cert, _ = write_credential_files(after, known_hosts_path=known)
    result = subprocess.run(
        ssh_argv(after, key, cert, known, "true"), capture_output=True, text=True, timeout=60
    )
    assert result.returncode == 0, (
        "host key changed across stop/start; a changed fingerprint is "
        f"indistinguishable from interception. {result.stderr}"
    )
    assert known.read_text() == pinned, "known_hosts gained a second entry for the same host"


# ─── isolation matrix ───────────────────────────────────────────────────────


async def test_a_certificate_for_another_box_is_rejected(rt, image, box):
    await wait_for_ssh_ready(box)
    other = await rt.create(__import__("boxlite").BoxOptions(image=image, auto_remove=True))
    try:
        await wait_for_ssh_ready(other)
        foreign = await other.ssh_certificates().issue()

        # Point the foreign certificate at *this* box's endpoint.
        key, cert, known = write_credential_files(foreign)
        argv = ssh_argv(foreign, key, cert, known, "true")
        target = await box.ssh_certificates().issue()
        argv[argv.index(f"root@{foreign.credential.host}")] = f"root@{target.credential.host}"
        argv[argv.index(f"ProxyCommand={foreign.credential.proxy_command}")] = (
            f"ProxyCommand={target.credential.proxy_command}"
        )

        result = subprocess.run(argv, capture_output=True, text=True, timeout=60)
        assert result.returncode != 0, "a certificate bound to another box must not authenticate"
    finally:
        await rt.remove(other.id, force=True)


async def test_a_non_root_login_user_is_rejected(box):
    await wait_for_ssh_ready(box)
    bundle = await box.ssh_certificates().issue()
    key, cert, known = write_credential_files(bundle)

    argv = ssh_argv(bundle, key, cert, known, "true")
    argv[-2] = f"ubuntu@{bundle.credential.host}"
    result = subprocess.run(argv, capture_output=True, text=True, timeout=60)

    assert result.returncode != 0


async def test_a_raw_key_without_a_certificate_is_rejected(box):
    await wait_for_ssh_ready(box)
    bundle = await box.ssh_certificates().issue()
    key, _cert, known = write_credential_files(bundle)

    # Same key, but no CertificateFile: authority comes only from the CA
    # signature, never from possession of a key the guest has never seen.
    result = subprocess.run(
        [
            "ssh",
            "-i", str(key),
            "-o", f"UserKnownHostsFile={known}",
            "-o", "StrictHostKeyChecking=accept-new",
            "-o", "IdentitiesOnly=yes",
            "-o", "BatchMode=yes",
            "-o", f"ProxyCommand={bundle.credential.proxy_command}",
            "-p", str(bundle.credential.port),
            f"root@{bundle.credential.host}",
            "true",
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode != 0


def principals_of(cert_path: Path) -> list[str]:
    """Read the principals OpenSSH sees in a certificate.

    Taken from the real issued certificate rather than reconstructed, so the
    rogue certificate below differs from it in exactly one respect: the CA.
    """
    listing = subprocess.run(
        ["ssh-keygen", "-L", "-f", str(cert_path)],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    principals: list[str] = []
    collecting = False
    for line in listing.splitlines():
        stripped = line.strip()
        if stripped.startswith("Principals:"):
            collecting = True
            continue
        if collecting:
            # `ssh-keygen -L` indents the following sections too, so stop on
            # the next section header rather than on indentation. A principal
            # never looks like `Name:` or `Name: value` — note `org:org-1` has
            # no space after its colon.
            if not stripped or stripped.endswith(":") or ": " in stripped:
                break
            principals.append(stripped)
    assert principals, f"no principals parsed from {listing!r}"
    return principals


async def test_a_self_signed_certificate_from_an_untrusted_ca_is_rejected(box):
    await wait_for_ssh_ready(box)
    bundle = await box.ssh_certificates().issue()
    key, real_cert, known = write_credential_files(bundle)
    tmp = key.parent

    # Derive the public key first: `write_credential_files` writes only the
    # private key and the certificate, and `ssh-keygen -s` needs the .pub.
    pub = tmp / "id_ed25519.pub"
    pub.write_text(
        subprocess.run(
            ["ssh-keygen", "-y", "-f", str(key)], capture_output=True, text=True, check=True
        ).stdout
    )

    # Mint our own CA and re-sign with the SAME principals the real certificate
    # carries. The guest demands exactly `root`, `box:<id>` and `org:<id>`, so
    # signing only `-n root` would be rejected as a principal mismatch and
    # would prove nothing about CA trust.
    ca = tmp / "rogue_ca"
    subprocess.run(
        ["ssh-keygen", "-t", "ed25519", "-N", "", "-f", str(ca)], check=True, capture_output=True
    )
    subprocess.run(
        [
            "ssh-keygen", "-s", str(ca), "-I", "rogue",
            "-n", ",".join(principals_of(real_cert)),
            "-V", "-5m:+5m", str(pub),
        ],
        check=True,
        capture_output=True,
    )

    # ssh-keygen -s writes <pub-basename>-cert.pub, overwriting the real one.
    rogue_cert = tmp / "id_ed25519-cert.pub"
    result = subprocess.run(
        ssh_argv(bundle, key, rogue_cert, known, "true"),
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert result.returncode != 0, "a certificate from an untrusted CA must not authenticate"
