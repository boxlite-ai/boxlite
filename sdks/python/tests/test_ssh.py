"""
SSH bindings unit tests (no VM required).

Two environments run this file. The CI unit job collects it before the
native extension is built: the sync wrapper is driven against a stand-in
native module and the pure-Python SyncSshHandle export checks run, while
the native tests skip — solely because the extension module file is
absent. Runs after `make dev:python` (and every integration run) load the
real classes: an extension that exists but cannot be imported, or that
lacks the SSH types, fails the run instead of skipping.
"""

from __future__ import annotations

import importlib.util
import sys
import types

import pytest

from boxlite.errors import NotFoundError

# Skip only when the extension module file itself is absent (the CI unit
# job collects this file before any build). When the module exists, the
# unguarded import below must succeed: an unloadable extension or missing
# SSH types is a build break, not a skip.
NATIVE_MODULE_ABSENT = importlib.util.find_spec("boxlite.boxlite") is None

if not NATIVE_MODULE_ABSENT:
    from boxlite.boxlite import SshAccount, SshCaConfig, SshConfig

requires_native = pytest.mark.skipif(
    NATIVE_MODULE_ABSENT, reason="native extension module not built"
)


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


@pytest.fixture
def sync_api():
    if importlib.util.find_spec("greenlet") is None:
        pytest.skip("greenlet not installed")
    from boxlite import sync_api

    return sync_api


@pytest.fixture
def _native_stand_in(monkeypatch, sync_api):
    """Stand in for `boxlite.boxlite`; only the sync wrapper tests install it."""
    native = types.ModuleType("boxlite.boxlite")
    native.Boxlite = _NativeBoxlite
    monkeypatch.setitem(sys.modules, "boxlite.boxlite", native)


@pytest.fixture
def sync_box(_native_stand_in, sync_api):
    with sync_api.SyncBoxlite.rest(object()) as runtime:
        yield sync_api.SyncBox(runtime, _NativeBox())


class TestSyncSshHandle:
    def test_ssh_returns_a_cached_sync_handle(self, sync_box, sync_api):
        assert isinstance(sync_box.ssh, sync_api.SyncSshHandle)
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


@requires_native
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


@requires_native
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


@requires_native
def test_public_exports():
    import boxlite

    for name in ("SshConfig", "SshAccount", "SshCaConfig", "SshStatus", "SshHandle"):
        assert name in boxlite.__all__
        assert getattr(boxlite, name) is not None


# Pure-Python exports: these must hold in both environments, with or
# without the native extension; only greenlet is required.
def test_sync_ssh_handle_is_exported_at_top_level(sync_api):
    import boxlite

    assert "SyncSshHandle" in boxlite.__all__
    assert boxlite.SyncSshHandle is sync_api.SyncSshHandle


def test_sync_ssh_handle_is_exported_from_sync_api(sync_api):
    from boxlite.sync_api._ssh import SyncSshHandle

    assert "SyncSshHandle" in sync_api.__all__
    assert sync_api.SyncSshHandle is SyncSshHandle
