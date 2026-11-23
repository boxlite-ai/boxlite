"""Test the shipped local launcher across a real subprocess boundary."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[2] / 'plugins/boxlite/skills/boxlite/scripts/local.py'
spec = importlib.util.spec_from_file_location('local_mode', SCRIPT)
local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local)


class LocalModeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.home = self.root / 'runtime'
        self.home.mkdir()
        self.cli = self.root / 'boxlite'
        self.cli.write_text('#!' + sys.executable + '\nimport json, os, sys\n'
                            'print(json.dumps({"argv":sys.argv[1:],"routing":'
                            '{k:v for k,v in os.environ.items() if k.startswith("BOXLITE_")}}))\n'
                            'sys.exit(int(os.environ.get("TEST_CHILD_EXIT", "0")))\n')
        self.cli.chmod(0o755)
        self.config = self.root / 'mode.json'
        self.write_config(mode='local', home=str(self.home), cli=str(self.cli))

    def write_config(self, **value):
        self.config.write_text(json.dumps(value))

    def invoke(self, *args):
        return local.run(self.config, list(args), capture_output=True, text=True)

    def test_inherited_cloud_settings_cannot_redirect_local_execution(self):
        cloud = {name: 'synthetic-conflicting-value' for name in local.ENVIRONMENT}
        with patch.dict(os.environ, cloud):
            result = self.invoke('exec', 'box-id', '--', 'echo', 'hello')
        self.assertEqual(result.returncode, 0)
        result = json.loads(result.stdout)
        self.assertEqual(result['argv'], ['--home', str(self.home), '--profile', 'default',
                                          'exec', 'box-id', '--', 'echo', 'hello'])
        self.assertFalse(set(result['routing']).intersection(local.ENVIRONMENT))

    def test_every_routing_selector_is_rejected_before_execution(self):
        for option in local.ROUTING:
            for spelling in ([option, 'other'], [option + '=other']):
                with self.subTest(spelling=spelling):
                    with self.assertRaisesRegex(ValueError, 'Routing overrides'):
                        self.invoke('list', *spelling)

    def test_guest_arguments_are_preserved_without_shell_interpretation(self):
        guest = ['echo', '--url=guest', '--profile', 'guest', '$(touch forbidden)', ';', 'two words']
        result = self.invoke('exec', 'box-id', '--', *guest)
        self.assertEqual(json.loads(result.stdout)['argv'][-len(guest):], guest)

    def test_credentials_even_a_broken_link_block_local_mode(self):
        credentials = self.home / 'credentials.toml'
        for link in (False, True):
            with self.subTest(link=link):
                if link:
                    credentials.symlink_to(self.root / 'missing')
                else:
                    credentials.write_text('[profiles.default]\nurl="https://api.boxlite.ai"\n')
                with self.assertRaisesRegex(ValueError, 'credential store'):
                    self.invoke('list')
                credentials.unlink()

    def test_cloud_modes_and_secret_configuration_fields_are_rejected(self):
        for mode in ('cloud-oauth', 'cloud-api', None):
            self.write_config(mode=mode, home=str(self.home))
            with self.assertRaisesRegex(ValueError, 'local-only'):
                self.invoke('list')
        self.write_config(mode='local', home=str(self.home), api_key='synthetic')
        with self.assertRaisesRegex(ValueError, 'only mode'):
            self.invoke('list')

    def test_invalid_input_does_not_launch_a_process(self):
        for value in ('[]', '{', 'null'):
            self.config.write_text(value)
            with self.assertRaises(ValueError):
                self.invoke('list')
        for home in ('relative', None, 42):
            self.write_config(mode='local', home=home)
            with self.assertRaisesRegex(ValueError, 'absolute'):
                self.invoke('list')
        self.write_config(mode='local', home=str(self.home), cli=str(self.cli))
        for command in ('auth', 'context', 'serve', '--url'):
            with self.assertRaisesRegex(ValueError, 'workload'):
                self.invoke(command)

    def test_child_failure_is_not_reported_as_success(self):
        with patch.dict(os.environ, {'TEST_CHILD_EXIT': '7'}):
            result = self.invoke('exec', 'box-id', '--', 'false')
        self.assertEqual(result.returncode, 7)
