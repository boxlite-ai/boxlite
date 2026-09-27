"""Credential source fallback checks."""

import subprocess
import unittest
from unittest.mock import patch

from compose import registries


class GhcrCredentialsTests(unittest.TestCase):
    @patch.dict("os.environ", {}, clear=True)
    @patch.object(registries, "_credstore_get", return_value=("docker-user", "docker-token"))
    @patch.object(registries.shutil, "which", return_value="/usr/bin/gh")
    def test_cli_failure_falls_back_to_docker(self, _which, credstore):
        def failed_cli(command, **kwargs):
            if kwargs.get("check"):
                raise subprocess.CalledProcessError(1, command)
            return subprocess.CompletedProcess(command, 1, stdout="invalid-token")

        with patch.object(registries.subprocess, "run", side_effect=failed_cli):
            self.assertEqual(registries.ghcr_creds(), ("docker-user", "docker-token"))
        credstore.assert_called_once_with("ghcr.io")

    @patch.dict("os.environ", {}, clear=True)
    @patch.object(registries, "_credstore_get", return_value=("docker-user", "docker-token"))
    @patch.object(registries.shutil, "which", return_value="/usr/bin/gh")
    def test_cli_timeout_falls_back_to_docker(self, _which, credstore):
        with patch.object(registries.subprocess, "run", side_effect=subprocess.TimeoutExpired("gh", 5)):
            self.assertEqual(registries.ghcr_creds(), ("docker-user", "docker-token"))
        credstore.assert_called_once_with("ghcr.io")

    @patch.dict("os.environ", {}, clear=True)
    @patch.object(registries, "_credstore_get", return_value=("docker-user", "docker-token"))
    @patch.object(registries.shutil, "which", return_value="/usr/bin/gh")
    def test_unexpected_error_is_not_hidden(self, _which, credstore):
        with patch.object(registries.subprocess, "run", side_effect=ValueError("unexpected")):
            with self.assertRaisesRegex(ValueError, "unexpected"):
                registries.ghcr_creds()
        credstore.assert_not_called()
