"""
SSH bindings unit tests (no VM required).

Two layers, matching the repo's existing mock style: the sync wrapper is
driven against a stand-in native module (these run in the CI unit job,
which does not build the extension), and the native classes are tested
directly when the extension is importable (unit runs after `make
dev:python` and every integration run).
"""

from __future__ import annotations

import sys
import types

import pytest

pytest.importorskip("greenlet")

from boxlite.errors import NotFoundError
from boxlite.sync_api import SyncBox, SyncBoxlite, SyncSshHandle

try:
    from boxlite.boxlite import SshAccount, SshCaConfig, SshConfig

    NATIVE_AVAILABLE = True
except ImportError:
    NATIVE_AVAILABLE = False


# ── Sync wrapper over a stand-in native module ────────────────────────────────


class _NativeSsh:
    """Answers like the native SshHandle and records each call."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []

    async def configure(self, config):
        self.calls.append(("configure", config))
        return "configured"

    async def status(self):
        self.calls.append(("status",))
        return "status"

    async def disable(self):
        self.calls.append(("disable",))
        return "disabled"


class _NativeBox:
    """Stands in for the native Box: only `.ssh` is exercised."""

    def __init__(self) -> None:
        self.ssh = _NativeSsh()


class _NativeBoxlite:
    """Stands in for the native Boxlite; never called here."""

    def __init__(self, options=None) -> None:
        self.options = options

    @classmethod
    def rest(cls, options) -> _NativeBoxlite:
        return cls(options)


@pytest.fixture(autouse=True)
def _native_stand_in(monkeypatch):
    native = types.ModuleType("boxlite.boxlite")
    native.Boxlite = _NativeBoxlite
    monkeypatch.setitem(sys.modules, "boxlite.boxlite", native)


@pytest.fixture
def sync_box():
    with SyncBoxlite.rest(object()) as runtime:
        yield SyncBox(runtime, _NativeBox())


class TestSyncSshHandle:
    def test_ssh_returns_a_cached_sync_handle(self, sync_box):
        assert isinstance(sync_box.ssh, SyncSshHandle)
        assert sync_box.ssh is sync_box.ssh

    def test_each_call_returns_what_the_native_call_answered(self, sync_box):
        assert sync_box.ssh.configure("config") == "configured"
        assert sync_box.ssh.status() == "status"
        assert sync_box.ssh.disable() == "disabled"

        assert sync_box._box.ssh.calls == [
            ("configure", "config"),
            ("status",),
            ("disable",),
        ]

    def test_a_failure_keeps_its_class(self, sync_box):
        async def refuse():
            raise NotFoundError("box is gone")

        sync_box._box.ssh.status = refuse
        with pytest.raises(NotFoundError, match="box is gone"):
            sync_box.ssh.status()


# ── Native classes (extension build required) ─────────────────────────────────

HOST_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n"
USER_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAtLeakCheck user@test"
CA_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILeakCheckCA ca@test"


def _native_config():
    return SshConfig(
        listen_address="0.0.0.0:2222",
        host_private_key=HOST_KEY,
        accounts=[
            SshAccount(
                login="alice",
                authorized_keys=[USER_KEY],
                ca=SshCaConfig(CA_KEY, "alice"),
            )
        ],
    )


@pytest.mark.skipif(not NATIVE_AVAILABLE, reason="native extension not built")
class TestNativeReprRedaction:
    """repr() must keep diagnostics useful without exposing credentials."""

    @pytest.mark.parametrize("secret", [HOST_KEY, USER_KEY, CA_KEY])
    def test_config_repr_redacts_every_credential(self, secret):
        assert secret not in repr(_native_config())

    def test_config_repr_keeps_the_listener_address(self):
        text = repr(_native_config())
        assert "0.0.0.0:2222" in text
        assert "[REDACTED]" in text

    @pytest.mark.parametrize("secret", [USER_KEY, CA_KEY])
    def test_account_repr_redacts_keys_but_not_the_login(self, secret):
        text = repr(_native_config().accounts[0])
        assert secret not in text
        assert "alice" in text
        assert "[REDACTED]" in text

    def test_ca_repr_redacts_key_and_principal(self):
        text = repr(SshCaConfig(CA_KEY, "leak-principal"))
        assert CA_KEY not in text
        assert "leak-principal" not in text
        assert text.count("[REDACTED]") == 2


@pytest.mark.skipif(not NATIVE_AVAILABLE, reason="native extension not built")
class TestNativeConstruction:
    def test_defaults_are_empty_credentials(self):
        account = SshAccount(login="bob")
        assert account.authorized_keys == []
        assert account.ca is None
        assert SshConfig("127.0.0.1:22", HOST_KEY).accounts == []

    def test_fields_round_trip(self):
        config = _native_config()
        assert config.listen_address == "0.0.0.0:2222"
        assert config.host_private_key == HOST_KEY
        (account,) = config.accounts
        assert account.login == "alice"
        assert account.authorized_keys == [USER_KEY]
        assert account.ca.public_key == CA_KEY
        assert account.ca.principal == "alice"

    def test_account_without_ca_renders_none(self):
        assert repr(SshAccount(login="bob")) == (
            'SshAccount(login="bob", authorized_keys=[REDACTED], ca=None)'
        )

    def test_non_string_login_is_a_type_error(self):
        with pytest.raises(TypeError):
            SshAccount(login=42)

    def test_non_account_entries_are_rejected(self):
        with pytest.raises(TypeError):
            SshConfig("0.0.0.0:2222", HOST_KEY, accounts=["alice"])


def test_public_exports():
    import boxlite

    for name in ("SshConfig", "SshAccount", "SshCaConfig", "SshStatus", "SshHandle"):
        assert name in boxlite.__all__
        assert getattr(boxlite, name, None) is not None or not NATIVE_AVAILABLE
