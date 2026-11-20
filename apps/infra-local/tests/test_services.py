"""Service specs that must hold inside a Box; no VMs."""

import json
from pathlib import Path
import tempfile
import unittest

from compose import services
from compose.config import InfraConfig


class ServiceSpecTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.cfg = InfraConfig(repo_root=root, data_dir=root / "data", boxlite_home=root / "home")

    def test_pgadmin_listens_on_an_unprivileged_published_port(self):
        # pgAdmin runs as uid 5050 and a Box grants it no low-port binding,
        # so the port it listens on must be >= 1024 and must be the one published.
        spec = services.SERVICES["pgadmin"]
        listen = int(spec.env(self.cfg).get("PGADMIN_LISTEN_PORT", "80"))
        self.assertGreaterEqual(listen, 1024)
        self.assertEqual([guest for _, guest in spec.ports], [listen])

    def test_rauthy_serves_the_mounted_repo_config_on_its_issuer_port(self):
        cfg = InfraConfig(repo_root=Path(__file__).resolve().parents[3])
        spec = services.SERVICES["rauthy"]
        [(source, target)] = spec.volumes(cfg)
        config = spec.cmd[spec.cmd.index("--config-file") + 1]
        self.assertTrue((Path(source) / Path(config).relative_to(target)).is_file())
        for name in ("users.json", "clients.json", "scopes.json"):
            self.assertTrue((Path(source) / "bootstrap" / name).is_file(), name)
        [(host, _)] = spec.ports
        self.assertEqual(host, cfg.rauthy_host_port)
        self.assertTrue(spec.healthcheck.http_url.startswith(f"http://127.0.0.1:{host}/auth/v1/"))
        self.assertEqual(spec.env(cfg)["PUB_URL"], cfg.rauthy_issuer.split("/")[2])

    def test_rauthy_seed_users_use_ids_rauthy_accepts(self):
        cfg = InfraConfig(repo_root=Path(__file__).resolve().parents[3])
        [(source, _)] = services.SERVICES["rauthy"].volumes(cfg)
        users = json.loads((Path(source) / "bootstrap" / "users.json").read_text())
        for user in users:
            self.assertRegex(user["id"], r"^[a-zA-Z0-9]{24}$", user["email"])


if __name__ == "__main__":
    unittest.main()
