from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import unittest
from fastapi.testclient import TestClient
from test_handle_cache import SERVER


class SshRoutesTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(SERVER.app)
        self.status = SimpleNamespace(
            enabled=True,
            generation=2**64 - 1,
            listen_address="addr",
            host_public_key="key",
            host_key_fingerprint="fp",
        )
        self.ssh = SimpleNamespace(
            status=AsyncMock(return_value=self.status),
            disable=AsyncMock(return_value=self.status),
            configure=AsyncMock(return_value=self.status),
        )
        self.box = SimpleNamespace(
            ssh=self.ssh,
            info=AsyncMock(
                return_value=SimpleNamespace(
                    state=SimpleNamespace(status="running"), auto_resume=False
                )
            ),
        )
        self.resolve = patch.object(
            SERVER, "get_box_or_404", AsyncMock(return_value=self.box)
        )
        self.resolve.start()
        self.addCleanup(self.resolve.stop)

    def test_ssh_auth_status_disable_and_precision(self):
        path = "/v1/team/boxes/alias/ssh"
        self.assertEqual(self.client.get(path).status_code, 401)
        headers = {"Authorization": "Bearer test"}
        response = self.client.get(path, headers=headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["generation"], 2**64 - 1)
        self.assertEqual(
            self.client.post(path + "/disable", headers=headers).status_code, 200
        )
        self.ssh.disable.assert_awaited_once()

    def test_ssh_invalid_config_never_echoes_input(self):
        response = self.client.post(
            "/v1/team/boxes/alias/ssh/configure",
            headers={"Authorization": "Bearer test"},
            json={
                "host_private_key": "sentinel-private",
                "accounts": "sentinel-secret",
            },
        )
        self.assertEqual(response.status_code, 400)
        self.assertNotIn("sentinel", response.text)
        self.ssh.configure.assert_not_awaited()

    def test_ssh_autoresume_off_refuses_all_operations(self):
        self.box.info.return_value.state.status = "stopped"
        for suffix, method in [("", self.client.get), ("/disable", self.client.post)]:
            self.assertEqual(
                method(
                    "/v1/team/boxes/alias/ssh" + suffix,
                    headers={"Authorization": "Bearer test"},
                ).status_code,
                409,
            )
        self.ssh.status.assert_not_awaited()
        self.ssh.disable.assert_not_awaited()

    def test_ssh_autoresume_on_allows_status(self):
        self.box.info.return_value.state.status = "stopped"
        self.box.info.return_value.auto_resume = True
        self.assertEqual(
            self.client.get(
                "/v1/team/boxes/alias/ssh", headers={"Authorization": "Bearer test"}
            ).status_code,
            200,
        )

    def test_ssh_configure_converts_nested_credentials(self):
        config = {
            "listen_address": "addr",
            "host_private_key": "private",
            "accounts": [
                {
                    "login": "alice",
                    "authorized_keys": ["key"],
                    "ca": {"public_key": "ca", "principal": "principal"},
                }
            ],
        }
        with (
            patch.object(
                SERVER.boxlite,
                "SshCaConfig",
                side_effect=lambda key, principal: SimpleNamespace(
                    public_key=key, principal=principal
                ),
                create=True,
            ),
            patch.object(
                SERVER.boxlite,
                "SshAccount",
                side_effect=lambda login, keys, ca: SimpleNamespace(
                    login=login, authorized_keys=keys, ca=ca
                ),
                create=True,
            ),
            patch.object(
                SERVER.boxlite,
                "SshConfig",
                side_effect=lambda address, key, accounts: SimpleNamespace(
                    listen_address=address, host_private_key=key, accounts=accounts
                ),
                create=True,
            ),
        ):
            response = self.client.post(
                "/v1/team/boxes/alias/ssh/configure",
                headers={"Authorization": "Bearer test"},
                json=config,
            )
            self.assertEqual(response.status_code, 200)
            self.assertNotIn("private", response.text)
            native = self.ssh.configure.call_args.args[0]
            self.assertEqual(native.accounts[0].ca.principal, "principal")
            self.assertEqual(native.accounts[0].authorized_keys, ["key"])
            self.box.info.return_value.state.status = "stopped"
            response = self.client.post(
                "/v1/team/boxes/alias/ssh/configure",
                headers={"Authorization": "Bearer test"},
                json=config,
            )
            self.assertEqual(response.status_code, 409)
            self.assertEqual(self.ssh.configure.await_count, 1)
