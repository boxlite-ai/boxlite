from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


CONFIG_PATH = Path(__file__).resolve().parents[1] / "config.py"
SPEC = importlib.util.spec_from_file_location("reference_server_config", CONFIG_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Failed to load config module spec from {CONFIG_PATH}")
CONFIG = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CONFIG
SPEC.loader.exec_module(CONFIG)


class ReferenceServerConfigTests(unittest.TestCase):
    def test_defaults_when_env_is_empty(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            server = CONFIG.load_server_config_from_env()
            runtime = CONFIG.load_runtime_config_from_env()

        self.assertEqual(server.host, CONFIG.DEFAULT_SERVER_HOST)
        self.assertEqual(server.port, CONFIG.DEFAULT_SERVER_PORT)
        self.assertEqual(server.log_level, CONFIG.DEFAULT_SERVER_LOG_LEVEL)
        self.assertEqual(server.jwt_secret, CONFIG.DEFAULT_SERVER_JWT_SECRET)
        self.assertEqual(
            server.jwt_expiry_seconds, CONFIG.DEFAULT_SERVER_JWT_EXPIRY_SECONDS
        )
        self.assertEqual(server.client_id, CONFIG.DEFAULT_SERVER_CLIENT_ID)
        self.assertEqual(server.client_secret, CONFIG.DEFAULT_SERVER_CLIENT_SECRET)
        self.assertEqual(runtime.home_dir, CONFIG.default_runtime_home_dir())
        self.assertEqual(
            runtime.image_registries, CONFIG.DEFAULT_RUNTIME_IMAGE_REGISTRIES
        )

    def test_env_overrides_for_all_server_and_runtime_options(self) -> None:
        with tempfile.TemporaryDirectory() as temp_home:
            with patch.dict(
                os.environ,
                {
                    "BOXLITE_SERVER_HOST": "127.0.0.1",
                    "BOXLITE_SERVER_PORT": "9090",
                    "BOXLITE_SERVER_LOG_LEVEL": "debug",
                    "BOXLITE_SERVER_JWT_SECRET": "secret-123",
                    "BOXLITE_SERVER_JWT_EXPIRY_SECONDS": "7200",
                    "BOXLITE_SERVER_CLIENT_ID": "client-123",
                    "BOXLITE_SERVER_CLIENT_SECRET": "secret-456",
                    "BOXLITE_RUNTIME_HOME_DIR": temp_home,
                    "BOXLITE_RUNTIME_IMAGE_REGISTRIES": "ghcr.io,docker.io",
                },
                clear=True,
            ):
                server = CONFIG.load_server_config_from_env()
                runtime = CONFIG.load_runtime_config_from_env()

        self.assertEqual(server.host, "127.0.0.1")
        self.assertEqual(server.port, 9090)
        self.assertEqual(server.log_level, "debug")
        self.assertEqual(server.jwt_secret, "secret-123")
        self.assertEqual(server.jwt_expiry_seconds, 7200)
        self.assertEqual(server.client_id, "client-123")
        self.assertEqual(server.client_secret, "secret-456")
        self.assertEqual(runtime.home_dir, temp_home)
        self.assertEqual(runtime.image_registries, ["ghcr.io", "docker.io"])

    def test_invalid_int_env_fails_fast(self) -> None:
        with patch.dict(os.environ, {"BOXLITE_SERVER_PORT": "oops"}, clear=True):
            with self.assertRaisesRegex(
                ValueError, "BOXLITE_SERVER_PORT must be an integer"
            ):
                CONFIG.load_server_config_from_env()

        with patch.dict(
            os.environ, {"BOXLITE_SERVER_JWT_EXPIRY_SECONDS": "0"}, clear=True
        ):
            with self.assertRaisesRegex(
                ValueError, "BOXLITE_SERVER_JWT_EXPIRY_SECONDS must be >= 1"
            ):
                CONFIG.load_server_config_from_env()

    def test_invalid_csv_env_fails_fast(self) -> None:
        with patch.dict(
            os.environ, {"BOXLITE_RUNTIME_IMAGE_REGISTRIES": "ghcr.io,,docker.io"}, clear=True
        ):
            with self.assertRaisesRegex(
                ValueError,
                "BOXLITE_RUNTIME_IMAGE_REGISTRIES must be a comma-separated list",
            ):
                CONFIG.load_runtime_config_from_env()

    def test_invalid_log_level_fails_fast(self) -> None:
        with patch.dict(os.environ, {"BOXLITE_SERVER_LOG_LEVEL": "verbose"}, clear=True):
            with self.assertRaisesRegex(ValueError, "log level must be one of"):
                CONFIG.load_server_config_from_env()

    def test_cli_overrides_env_for_host_port_and_log_level(self) -> None:
        with patch.dict(
            os.environ,
            {
                "BOXLITE_SERVER_HOST": "10.0.0.10",
                "BOXLITE_SERVER_PORT": "9000",
                "BOXLITE_SERVER_LOG_LEVEL": "debug",
            },
            clear=True,
        ):
            defaults = CONFIG.load_server_config_from_env()
            parser = CONFIG.build_main_parser(defaults)
            args = parser.parse_args(
                ["--host", "127.0.0.1", "--port", "8081", "--log-level", "warning"]
            )

        self.assertEqual(args.host, "127.0.0.1")
        self.assertEqual(args.port, 8081)
        self.assertEqual(args.log_level, "warning")

    def test_runtime_home_ignores_boxlite_home_env(self) -> None:
        with patch.dict(os.environ, {"BOXLITE_HOME": "/tmp/legacy-home"}, clear=True):
            runtime = CONFIG.load_runtime_config_from_env()

        self.assertEqual(runtime.home_dir, CONFIG.default_runtime_home_dir())
        self.assertNotEqual(runtime.home_dir, "/tmp/legacy-home")

    def test_default_env_file_path_is_reference_server_local(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            default_env_path = Path(tempdir) / ".env"
            default_env_path.write_text("BOXLITE_SERVER_PORT=6060\n", encoding="utf-8")

            with patch.object(CONFIG, "DEFAULT_ENV_FILE_PATH", default_env_path):
                with patch.dict(os.environ, {}, clear=True):
                    loaded = CONFIG.load_env_file(None)
                    server = CONFIG.load_server_config_from_env()

        self.assertEqual(loaded, default_env_path)
        self.assertEqual(server.port, 6060)

    def test_load_env_file_respects_existing_process_env(self) -> None:
        with tempfile.TemporaryDirectory() as tempdir:
            env_path = Path(tempdir) / "test.env"
            env_path.write_text(
                "\n".join(
                    [
                        "BOXLITE_SERVER_HOST=1.2.3.4",
                        "BOXLITE_SERVER_PORT=7777",
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            with patch.dict(os.environ, {"BOXLITE_SERVER_HOST": "9.9.9.9"}, clear=True):
                loaded = CONFIG.load_env_file(str(env_path))
                server = CONFIG.load_server_config_from_env()

        self.assertEqual(loaded, env_path)
        self.assertEqual(server.host, "9.9.9.9")
        self.assertEqual(server.port, 7777)

    def test_explicit_env_file_must_exist(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaisesRegex(ValueError, "--env-file path does not exist"):
                CONFIG.load_env_file("/definitely/not/here/.env")


if __name__ == "__main__":
    unittest.main()
