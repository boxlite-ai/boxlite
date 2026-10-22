"""
Native SSH control across a real REST boundary (no VM required).

The built extension is pointed at a loopback stub, so the requests the SSH
handle sends and the statuses it reads cross a real HTTP boundary through
PyO3, the async bridge, and the synchronous wrapper. A closing section pins
the BOXLITE_REQUIRE_NATIVE contract of the shared pytest configuration; it
shadows the package with the extension removed, so it runs in every
environment, extension or not.
"""

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

# Skip only when the extension module file itself is absent (the CI unit
# job collects this file before any build). When the module exists, the
# unguarded imports below must succeed: an unloadable extension or missing
# SSH types is a build break, not a skip.
NATIVE_MODULE_ABSENT = importlib.util.find_spec("boxlite.boxlite") is None

if not NATIVE_MODULE_ABSENT:
    from boxlite.boxlite import SshAccount, SshCaConfig, SshConfig

requires_native = pytest.mark.skipif(
    NATIVE_MODULE_ABSENT, reason="native extension module not built"
)

# ── A loopback stub for the box API's SSH routes ──────────────────────────────

BOX_ID = "box-ssh-rest-1"
NEAR_U64_MAX = 2**64 - 42
HOST_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n"
USER_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAtLeakCheck user@test"
CA_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILeakCheckCA ca@test"

BOX = {
    "box_id": BOX_ID,
    "name": "ssh-rest",
    "status": "running",
    "created_at": "2026-10-01T00:00:00Z",
    "updated_at": "2026-10-01T00:00:00Z",
    "pid": None,
    "image": "quay.io/acme/app:v1",
    "cpus": 2,
    "memory_mib": 512,
}

SSH_STATUS = {
    "enabled": True,
    "generation": NEAR_U64_MAX,
    "listen_address": "0.0.0.0:2222",
    "host_public_key": "ssh-ed25519 AAAAhost host@test",
    "host_key_fingerprint": "SHA256:abcdefg",
}


@pytest.fixture
def server():
    """A box API stub answering each (method, path) with a fixed reply.

    Yields its URL, the replies to fill in, and every (method, path, body)
    it received. A route with no reply answers 404.
    """
    replies: dict = {}
    requests: list = []

    class Handler(BaseHTTPRequestHandler):
        def _answer(self):
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode() if length else ""
            requests.append((self.command, self.path, body))
            status, reply = replies.get(
                (self.command, self.path), (404, {"message": "no route"})
            )
            payload = b"" if reply is None else json.dumps(reply).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = do_POST = do_DELETE = _answer

        def log_message(self, *args):
            pass

    http = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=http.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{http.server_address[1]}", replies, requests
    finally:
        http.shutdown()
        http.server_close()


def _native_config():
    return SshConfig(
        "0.0.0.0:2222",
        HOST_KEY,
        accounts=[
            SshAccount(
                "alice",
                [USER_KEY],
                ca=SshCaConfig(public_key=CA_KEY, principal="alice"),
            ),
            SshAccount("bob"),
        ],
    )


def _answered_box(server):
    """A real Box from `runtime.get`, with the box route already answered."""
    url, replies, _ = server
    replies[("GET", f"/v1/boxes/{BOX_ID}")] = (200, BOX)
    return url


# ── The async handle over the extension's REST runtime ────────────────────────


@requires_native
class TestAsyncSshOverRest:
    @pytest.mark.asyncio
    @pytest.mark.parametrize("assign_back", ["none", "accounts", "all"])
    async def test_configure_requires_assignment_at_each_level(
        self, server, assign_back
    ):
        import boxlite

        url = _answered_box(server)
        _, replies, requests = server
        replies[("POST", f"/v1/boxes/{BOX_ID}/ssh")] = (200, SSH_STATUS)
        config = _native_config()
        accounts = config.accounts
        account = accounts[0]
        keys = account.authorized_keys
        ca = account.ca
        account.login = "updated"
        keys.append("ssh-ed25519 AAAAupdated user@test")
        ca.public_key = "ssh-ed25519 AAAAupdated ca@test"
        ca.principal = "updated"
        accounts.append(SshAccount("carol"))
        if assign_back == "all":
            account.authorized_keys = keys
            account.ca = ca
        if assign_back != "none":
            config.accounts = accounts

        runtime = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(url=url))
        box = await runtime.get(BOX_ID)
        await box.ssh.configure(config)

        expected_accounts = [
            {
                "login": "alice" if assign_back == "none" else "updated",
                "authorized_keys": [USER_KEY],
                "ca": {"public_key": CA_KEY, "principal": "alice"},
            },
            {"login": "bob", "authorized_keys": [], "ca": None},
        ]
        if assign_back == "all":
            expected_accounts[0]["authorized_keys"].append(
                "ssh-ed25519 AAAAupdated user@test"
            )
            expected_accounts[0]["ca"] = {
                "public_key": "ssh-ed25519 AAAAupdated ca@test",
                "principal": "updated",
            }
        if assign_back != "none":
            expected_accounts.append(
                {"login": "carol", "authorized_keys": [], "ca": None}
            )
        assert [(method, path) for method, path, _ in requests] == [
            ("GET", f"/v1/boxes/{BOX_ID}"),
            ("POST", f"/v1/boxes/{BOX_ID}/ssh"),
        ]
        assert json.loads(requests[1][2]) == {
            "listen_address": "0.0.0.0:2222",
            "host_private_key": HOST_KEY,
            "accounts": expected_accounts,
        }

    @pytest.mark.asyncio
    async def test_configure_sends_nested_ca_and_preserves_empty_and_absent(
        self, server
    ):
        import boxlite

        url, replies, requests = server
        replies[("GET", f"/v1/boxes/{BOX_ID}")] = (200, BOX)
        replies[("POST", f"/v1/boxes/{BOX_ID}/ssh")] = (200, SSH_STATUS)

        runtime = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(url=url))
        box = await runtime.get(BOX_ID)
        status = await box.ssh.configure(_native_config())

        assert isinstance(status, boxlite.SshStatus)
        assert json.loads(requests[1][2]) == {
            "listen_address": "0.0.0.0:2222",
            "host_private_key": HOST_KEY,
            "accounts": [
                {
                    "login": "alice",
                    "authorized_keys": [USER_KEY],
                    "ca": {"public_key": CA_KEY, "principal": "alice"},
                },
                {"login": "bob", "authorized_keys": [], "ca": None},
            ],
        }
        # One request per operation: the get, then exactly one configure.
        assert [(method, path) for method, path, _ in requests] == [
            ("GET", f"/v1/boxes/{BOX_ID}"),
            ("POST", f"/v1/boxes/{BOX_ID}/ssh"),
        ]

    @pytest.mark.asyncio
    async def test_status_reads_every_field_with_full_generation(self, server):
        import boxlite

        url = _answered_box(server)
        _, replies, requests = server
        replies[("GET", f"/v1/boxes/{BOX_ID}/ssh")] = (200, SSH_STATUS)

        runtime = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(url=url))
        box = await runtime.get(BOX_ID)
        status = await box.ssh.status()

        assert (status.enabled, status.listen_address) == (True, "0.0.0.0:2222")
        assert status.host_public_key == "ssh-ed25519 AAAAhost host@test"
        assert status.host_key_fingerprint == "SHA256:abcdefg"
        # Near-u64-max stays an exact Python int, not a float that rounds.
        assert status.generation == NEAR_U64_MAX
        assert isinstance(status.generation, int)
        assert [(method, path) for method, path, _ in requests] == [
            ("GET", f"/v1/boxes/{BOX_ID}"),
            ("GET", f"/v1/boxes/{BOX_ID}/ssh"),
        ]

    @pytest.mark.asyncio
    async def test_disable_is_one_delete_and_returns_the_new_state(self, server):
        import boxlite

        url = _answered_box(server)
        _, replies, requests = server
        disabled = {**SSH_STATUS, "enabled": False}
        replies[("DELETE", f"/v1/boxes/{BOX_ID}/ssh")] = (200, disabled)

        runtime = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(url=url))
        box = await runtime.get(BOX_ID)
        status = await box.ssh.disable()

        assert status.enabled is False
        assert [(method, path) for method, path, _ in requests] == [
            ("GET", f"/v1/boxes/{BOX_ID}"),
            ("DELETE", f"/v1/boxes/{BOX_ID}/ssh"),
        ]


@requires_native
class TestAsyncSshErrorsKeepTheirClass:
    @pytest.mark.asyncio
    async def test_configure_surfaces_invalid_argument(self, server):
        import boxlite

        url = _answered_box(server)
        _, replies, requests = server
        replies[("POST", f"/v1/boxes/{BOX_ID}/ssh")] = (
            400,
            {"error": {"code": "invalid_argument", "message": "host key rejected"}},
        )

        runtime = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(url=url))
        box = await runtime.get(BOX_ID)
        with pytest.raises(boxlite.InvalidArgumentError) as caught:
            await box.ssh.configure(_native_config())

        assert "host key rejected" in str(caught.value)
        assert [(method, path) for method, path, _ in requests] == [
            ("GET", f"/v1/boxes/{BOX_ID}"),
            ("POST", f"/v1/boxes/{BOX_ID}/ssh"),
        ]

    @pytest.mark.asyncio
    async def test_status_surfaces_not_found(self, server):
        import boxlite

        url = _answered_box(server)
        _, replies, requests = server
        replies[("GET", f"/v1/boxes/{BOX_ID}/ssh")] = (
            404,
            {"error": {"code": "not_found", "message": "no ssh listener"}},
        )

        runtime = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(url=url))
        box = await runtime.get(BOX_ID)
        with pytest.raises(boxlite.NotFoundError) as caught:
            await box.ssh.status()

        assert "no ssh listener" in str(caught.value)
        assert [(method, path) for method, path, _ in requests] == [
            ("GET", f"/v1/boxes/{BOX_ID}"),
            ("GET", f"/v1/boxes/{BOX_ID}/ssh"),
        ]

    @pytest.mark.asyncio
    async def test_disable_surfaces_invalid_state(self, server):
        import boxlite

        url = _answered_box(server)
        _, replies, requests = server
        replies[("DELETE", f"/v1/boxes/{BOX_ID}/ssh")] = (
            409,
            {"error": {"code": "invalid_state", "message": "box is spent"}},
        )

        runtime = boxlite.Boxlite.rest(boxlite.BoxliteRestOptions(url=url))
        box = await runtime.get(BOX_ID)
        with pytest.raises(boxlite.InvalidStateError) as caught:
            await box.ssh.disable()

        assert "box is spent" in str(caught.value)
        assert [(method, path) for method, path, _ in requests] == [
            ("GET", f"/v1/boxes/{BOX_ID}"),
            ("DELETE", f"/v1/boxes/{BOX_ID}/ssh"),
        ]


# ── The synchronous wrapper over the same boundary ────────────────────────────


@requires_native
class TestSyncSshOverRest:
    def test_a_sync_box_manages_ssh_and_caches_its_handle(self, server):
        if importlib.util.find_spec("greenlet") is None:
            pytest.skip("greenlet not installed")

        import boxlite
        from boxlite.sync_api import SyncSshHandle

        url, replies, requests = server
        replies[("GET", f"/v1/boxes/{BOX_ID}")] = (200, BOX)
        replies[("POST", f"/v1/boxes/{BOX_ID}/ssh")] = (200, SSH_STATUS)
        replies[("GET", f"/v1/boxes/{BOX_ID}/ssh")] = (200, SSH_STATUS)
        replies[("DELETE", f"/v1/boxes/{BOX_ID}/ssh")] = (
            200,
            {**SSH_STATUS, "enabled": False},
        )

        sync = boxlite.SyncBoxlite
        with sync.rest(boxlite.BoxliteRestOptions(url=url)) as runtime:
            box = runtime.get(BOX_ID)
            assert box is not None
            assert box.ssh is box.ssh
            assert isinstance(box.ssh, SyncSshHandle)
            configured = box.ssh.configure(_native_config())
            assert configured.generation == NEAR_U64_MAX
            assert box.ssh.status().enabled is True
            assert box.ssh.disable().enabled is False

        assert [(method, path) for method, path, _ in requests] == [
            ("GET", f"/v1/boxes/{BOX_ID}"),
            ("POST", f"/v1/boxes/{BOX_ID}/ssh"),
            ("GET", f"/v1/boxes/{BOX_ID}/ssh"),
            ("DELETE", f"/v1/boxes/{BOX_ID}/ssh"),
        ]


# ── The BOXLITE_REQUIRE_NATIVE gate of the shared pytest configuration ────────
# These need no extension: each shadows `boxlite` with the real package minus
# its extension module, which is exactly the CI unit job's environment.

GATE = "BOXLITE_REQUIRE_NATIVE"


@pytest.fixture
def extensionless_boxlite(tmp_path):
    """The installed package copied without the extension module.

    Extra `boxlite/boxlite.py` content can be written by the test to make the
    module present but broken or incomplete.
    """
    import boxlite

    shadow = tmp_path / "shadow"
    shutil.copytree(
        Path(boxlite.__file__).parent,
        shadow / "boxlite",
        ignore=shutil.ignore_patterns("__pycache__", "*.so"),
    )
    return shadow / "boxlite"


def _import_conftest_under_gate(shadow_boxlite, tmp_path, gate=True):
    """Import the shared pytest configuration in a shadowed environment.

    pytest fails any run whose conftest cannot import, so importing it is
    the boundary the gate defends. The child runs from an empty directory
    with the shadow first on PYTHONPATH: `python -m pytest` would instead
    resolve `boxlite` from this source tree, where the extension exists.
    """
    cwd = tmp_path / "outside"
    cwd.mkdir()
    env = dict(os.environ)
    if gate:
        env[GATE] = "1"
    else:
        env.pop(GATE, None)
    env["PYTHONPATH"] = os.pathsep.join(
        [
            str(shadow_boxlite.parent),
            str(Path(__file__).resolve().parent),
            env.get("PYTHONPATH", ""),
        ]
    )
    return subprocess.run(
        [sys.executable, "-c", "import conftest"],
        cwd=cwd,
        check=False,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )


class TestRequireNativeGate:
    def test_an_absent_extension_fails_the_run(self, extensionless_boxlite, tmp_path):
        result = _import_conftest_under_gate(extensionless_boxlite, tmp_path)

        assert result.returncode != 0
        assert "boxlite.boxlite" in result.stdout + result.stderr

    def test_a_broken_extension_fails_the_run(self, extensionless_boxlite, tmp_path):
        (extensionless_boxlite / "boxlite.py").write_text(
            "raise ImportError('native stand-in rejected this interpreter')\n"
        )

        result = _import_conftest_under_gate(extensionless_boxlite, tmp_path)

        assert result.returncode != 0
        assert "native stand-in rejected this interpreter" in (
            result.stdout + result.stderr
        )

    def test_an_extension_without_ssh_types_fails_the_run(
        self, extensionless_boxlite, tmp_path
    ):
        (extensionless_boxlite / "boxlite.py").write_text("Boxlite = Box = object\n")

        result = _import_conftest_under_gate(extensionless_boxlite, tmp_path)

        output = result.stdout + result.stderr
        assert result.returncode != 0
        assert "cannot import name 'SshAccount'" in output

    def test_the_gate_stays_silent_without_the_variable(
        self, extensionless_boxlite, tmp_path
    ):
        result = _import_conftest_under_gate(
            extensionless_boxlite, tmp_path, gate=False
        )
        # Sanity for the red/green protocol: without the gate variable the
        # same import succeeds, proving the failures above come from the
        # gate and not the shadowed package.
        assert result.returncode == 0, result.stderr
