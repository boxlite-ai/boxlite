import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from compose.native import _Paths, _components, _parse_dotenv, _seed_api_env


class NativeApiEnvironmentTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.paths = _Paths(Path(self.directory.name))
        (self.paths.apps / "api").mkdir(parents=True)
        self.paths.infra_local.mkdir()
        shutil.copy(
            Path(__file__).resolve().parents[1] / "api.env",
            self.paths.infra_local / "api.env",
        )
        self.environment = patch.dict(os.environ, {}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def api_environment(self):
        return {**os.environ, **_components(self.paths)["api"].env}

    def test_fresh_environment_disables_publishing_without_commerce(self):
        _seed_api_env(self.paths)

        self.assertEqual(
            _parse_dotenv(self.paths.apps / "api" / ".env").get("BUSINESS_EVENTS_ENABLED"),
            "false",
        )
        self.assertEqual(self.api_environment().get("BUSINESS_EVENTS_ENABLED"), "false")

    def test_preexisting_api_environment_gets_the_local_default(self):
        (self.paths.apps / "api" / ".env").write_text("NODE_ENV=development\n")

        _seed_api_env(self.paths)

        self.assertEqual(self.api_environment().get("BUSINESS_EVENTS_ENABLED"), "false")

    def test_preexisting_apps_environment_gets_the_local_default(self):
        apps_env = self.paths.apps / ".env"
        apps_env.write_text("NODE_ENV=development\n")

        _seed_api_env(self.paths)

        self.assertEqual(apps_env.read_text(), "NODE_ENV=development\n")
        self.assertEqual(self.api_environment().get("BUSINESS_EVENTS_ENABLED"), "false")

    def test_explicit_environment_file_can_enable_publishing(self):
        (self.paths.apps / ".env").write_text(
            "BUSINESS_EVENTS_ENABLED=true\n"
            "USAGE_EXPORT_URL=http://commerce.test\n"
            "USAGE_EXPORT_TOKEN=test-token\n"
        )

        _seed_api_env(self.paths)

        self.assertEqual(self.api_environment()["BUSINESS_EVENTS_ENABLED"], "true")
        self.assertEqual(self.api_environment()["USAGE_EXPORT_URL"], "http://commerce.test")

    def test_inherited_explicit_setting_is_preserved_for_an_older_environment(self):
        os.environ["BUSINESS_EVENTS_ENABLED"] = "true"
        (self.paths.apps / "api" / ".env").write_text("NODE_ENV=development\n")

        _seed_api_env(self.paths)

        self.assertEqual(self.api_environment()["BUSINESS_EVENTS_ENABLED"], "true")
