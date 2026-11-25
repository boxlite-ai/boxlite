import importlib.util
import hashlib
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('package', REPO / 'scripts/plugins/boxlite.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class PackageTests(unittest.TestCase):
    def setUp(self):
        """Copy actual plugin resources into an isolated package root."""
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'plugin'
        self.claude = self.root.with_name('boxlite-claude')
        shutil.copytree(package.PLUGIN.with_name('boxlite-claude'), self.claude)
        for source in package.package_files(package.PLUGIN):
            target = self.root / source.relative_to(package.PLUGIN)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)

    def test_archive_excludes_caches_and_installs_from_standalone_marketplace(self):
        """Build identical archives and a catalog that resolves staged resources."""
        cache = self.root / 'node_modules/private.js'
        cache.parent.mkdir(parents=True)
        cache.write_text('cache')
        output = Path(self.temp.name) / 'output'
        archive = package.build(output, self.root)
        with zipfile.ZipFile(archive) as zipped:
            server = json.loads(zipped.read('mcp.json'))['mcpServers']['boxlite']
            self.assertEqual(server.get('extensions', {}).get('com.openai', {}).get('auth'),
                             {'type': 'oauth', 'client': {'mode': 'cimd'}})
            self.assertNotIn('hooks/transfer.js', zipped.namelist())
            self.assertIn('plugin.json', zipped.namelist())
            self.assertIn('skills/boxlite/SKILL.md', zipped.namelist())
            self.assertNotIn('.claude-plugin/plugin.json', zipped.namelist())
            self.assertNotIn('.codex-plugin/plugin.json', zipped.namelist())
            self.assertEqual(len(zipped.namelist()), 17)
            self.assertFalse(any('node_modules' in name for name in zipped.namelist()))
            self.assertFalse(any(name.startswith('templates/') for name in zipped.namelist()))
        catalog = json.loads((output / 'boxlite-marketplace/.agents/plugins/marketplace.json').read_text())
        target = output / 'boxlite-marketplace' / catalog['plugins'][0]['source']['path']
        self.assertTrue((target / 'plugin.json').exists())
        claude_catalog = json.loads((output / 'boxlite-marketplace/.claude-plugin/marketplace.json').read_text())
        claude_target = output / 'boxlite-marketplace' / claude_catalog['plugins'][0]['source']
        self.assertEqual(claude_target.name, "boxlite-claude")
        self.assertFalse((claude_target / "plugin.json").exists())
        self.assertTrue((claude_target / '.claude-plugin/plugin.json').exists())
        self.assertEqual(archive.read_bytes(), package.build(output, self.root).read_bytes())

    def test_submission_outputs_only_the_codex_archive(self):
        output = Path(self.temp.name) / 'submission'
        archive = package.build(output, self.root, marketplace_bundle=False)
        self.assertEqual(list(output.iterdir()), [archive])
        with zipfile.ZipFile(archive) as zipped:
            self.assertEqual(zipped.read('README.md'), (self.claude / 'README.md').read_bytes())
            self.assertEqual(set(zipped.namelist()), package.SHARED_SOURCE | package.CODEX_SOURCE)
            for name in package.SHARED_SOURCE:
                self.assertFalse((self.root / name).exists(), name)
                self.assertEqual(zipped.read(name), (self.claude / name).read_bytes())

    def test_installed_claude_uses_plugin_credentials(self):
        output = Path(self.temp.name) / 'output'
        package.build(output, self.root)
        marketplace = output / 'boxlite-marketplace'
        catalog = json.loads((marketplace / '.claude-plugin/marketplace.json').read_text())
        plugin = marketplace / catalog['plugins'][0]['source']
        guide = (plugin / 'skills/boxlite-setup/references/cloud-auth.md').read_text()
        self.assertNotIn('BOXLITE_API_KEY', guide)
        codex = marketplace / 'plugins/boxlite'
        for name in ('skills/boxlite-setup/references/cloud-auth.md', 'skills/boxlite/references/cloud.md'):
            self.assertEqual((codex / name).read_bytes(), (plugin / name).read_bytes())
        config = json.loads((plugin / '.claude-plugin/plugin.json').read_text())
        key = config['userConfig']['api_key']
        self.assertEqual((key['type'], key['sensitive'], key['required']), ('string', True, False))
        servers = json.loads((plugin / '.mcp.json').read_text())['mcpServers']
        self.assertEqual(servers, {
            'boxlite': {'type': 'http', 'url': package.MCP_URL},
            'boxlite-api': {'type': 'http', 'url': package.MCP_URL + '?connection=api-key',
                            'headers': {'Authorization': 'Bearer ${user_config.api_key}'}},
        })

    def test_claude_directory_rejects_source_drift(self):
        for name in ('plugin.json', 'missing-hook', '.claude-plugin/plugin.json'):
            with self.subTest(path=name):
                path = self.claude / ('hooks/transfer.js' if name == 'missing-hook' else name)
                original = path.read_bytes() if path.exists() else None
                if name == '.claude-plugin/plugin.json':
                    value = json.loads(original)
                    value['version'] = '99.0.0'
                    path.write_text(json.dumps(value))
                elif name == 'missing-hook':
                    path.unlink()
                else:
                    path.write_text('unexpected')
                with self.assertRaisesRegex(ValueError, 'Claude Directory'):
                    package.build(Path(self.temp.name) / 'output', self.root)
                if original is None:
                    path.unlink()
                else:
                    path.write_bytes(original)

    def test_rejects_claude_manifest_identity_drift(self):
        """Reject drift in each Claude identity field before staging a package."""
        manifest = self.claude / '.claude-plugin/plugin.json'
        original = manifest.read_text()
        for key, replacement in (('name', 'another-plugin'), ('version', '99.0.0'),
                                 ('description', 'Another plugin description.')):
            with self.subTest(field=key):
                value = json.loads(original)
                value[key] = replacement
                manifest.write_text(json.dumps(value))
                try:
                    with self.assertRaisesRegex(ValueError, f'Claude Directory identity differs: {key}'):
                        package.validate(self.root)
                finally:
                    manifest.write_text(original)

    def test_mcp_declarations_reject_credentials_and_endpoint_drift(self):
        for filename in ('mcp.json', '.mcp.json'):
            path = self.root / filename
            original = path.read_text()
            for mutation in ('url', 'type', 'headers', 'extensions', 'extra-server'):
                with self.subTest(file=filename, mutation=mutation):
                    value = json.loads(original)
                    server = value['mcpServers']['boxlite']
                    if mutation == 'extra-server':
                        value['mcpServers']['unexpected'] = dict(server)
                    elif mutation == 'url':
                        server['url'] = 'https://untrusted.example/mcp'
                    elif mutation == 'type':
                        server['type'] = 'stdio'
                    else:
                        server[mutation] = {'unexpected': 'value'}
                    path.write_text(json.dumps(value))
                    try:
                        with self.assertRaisesRegex(ValueError, 'Invalid MCP'):
                            package.build(Path(self.temp.name) / 'output', self.root)
                    finally:
                        path.write_text(original)

    def test_both_archives_are_reproducible_extractable_and_hashed(self):
        output = Path(self.temp.name) / 'output'
        package.build(output, self.root)
        original = {path.name: path.read_bytes() for path in output.glob('*.zip')}
        self.assertEqual(len(original), 2)
        package.build(output, self.root)
        self.assertEqual(original, {path.name: path.read_bytes() for path in output.glob('*.zip')})
        for line in (output / 'SHA256SUMS').read_text().splitlines():
            digest, name = line.split()
            self.assertEqual(digest, hashlib.sha256((output / name).read_bytes()).hexdigest())
        marketplace_zip = next(output.glob('boxlite-marketplace-*.zip'))
        extracted = output / 'extracted'
        with zipfile.ZipFile(marketplace_zip) as zipped:
            zipped.extractall(extracted)
        catalog = json.loads((extracted / '.claude-plugin/marketplace.json').read_text())
        self.assertTrue(package.validate_claude(extracted / catalog['plugins'][0]['source'],
                                               extracted / 'plugins/boxlite'))

    def test_inventory_rejects_undeclared_and_missing_resources(self):
        unknown = self.root / 'unexpected.txt'
        unknown.write_text('not declared')
        with self.assertRaisesRegex(ValueError, 'inventory'):
            package.validate(self.root)
        unknown.unlink()
        (self.claude / 'skills/boxlite/references/local.md').unlink()
        with self.assertRaisesRegex(ValueError, 'inventory'):
            package.validate(self.root)

    def test_artifact_names_follow_synchronized_stable_semver(self):
        for path in (self.root / 'plugin.json', self.claude / '.claude-plugin/plugin.json'):
            manifest = json.loads(path.read_text())
            manifest['version'] = '2.3.4'
            path.write_text(json.dumps(manifest))
        output = Path(self.temp.name) / 'output'
        self.assertEqual(package.build(output, self.root).name, 'boxlite-2.3.4.zip')
        self.assertTrue((output / 'boxlite-marketplace-2.3.4.zip').is_file())
        path = self.root / 'plugin.json'
        for version in ('02.3.4', '../../outside', '', 123):
            manifest = json.loads(path.read_text())
            manifest['version'] = version
            path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, 'identity/version'):
                package.build(output, self.root)

    def test_rejects_onboarding_outside_distributed_skill_inventory(self):
        """Reject excluded or undiscovered onboarding paths at the real build boundary."""
        portable = self.root / 'plugin.json'
        skill_text = (self.root / 'skills/boxlite-setup/SKILL.md').read_text()
        original = portable.read_text()
        for relative in ('node_modules/setup/SKILL.md', 'skills/dist/SKILL.md',
                         'references/setup/SKILL.md', 'node_modules/linked/SKILL.md'):
            with self.subTest(path=relative):
                skill = self.root / relative
                try:
                    skill.parent.mkdir(parents=True, exist_ok=True)
                    if relative == 'node_modules/linked/SKILL.md':
                        skill.symlink_to(self.root / 'skills/boxlite-setup/SKILL.md')
                    else:
                        skill.write_text(skill_text)
                    value = json.loads(original)
                    value['extensions']['com.openai']['onboardingSkill'] = './' + relative
                    portable.write_text(json.dumps(value))
                    with self.assertRaisesRegex(ValueError, 'packaged skill'):
                        package.build(Path(self.temp.name) / 'output', self.root)
                finally:
                    skill.unlink(missing_ok=True)
                    portable.write_text(original)

    def test_rebuild_removes_stale_marketplace_files(self):
        """Rebuild the real marketplace without retaining obsolete resources."""
        output = Path(self.temp.name) / 'output'
        archive = package.build(output, self.root)
        original = archive.read_bytes()
        marketplace = output / 'boxlite-marketplace'
        stale = [marketplace / 'obsolete-plugin/plugin.json',
                 marketplace / '.agents/plugins/obsolete.json']
        for path in stale:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('obsolete')
        rebuilt = package.build(output, self.root)
        for path in stale:
            self.assertFalse(path.exists(), str(path))
        self.assertTrue((marketplace / '.agents/plugins/marketplace.json').exists())
        self.assertTrue((marketplace / 'plugins/boxlite/plugin.json').exists())
        self.assertEqual(original, rebuilt.read_bytes())

    def test_rejects_private_deployment_state(self):
        """Reject deployment state instead of publishing it in the package."""
        (self.root / 'deployment.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'Private state'):
            package.validate(self.root)

    def test_rejects_symlink_and_manifest_path_escape(self):
        """Reject links and paths outside the package."""
        (self.root / 'outside').symlink_to('/etc/passwd')
        with self.assertRaisesRegex(ValueError, 'Symlink'):
            package.validate(self.root)
        (self.root / 'outside').unlink()
        manifest = self.root / 'plugin.json'
        value = json.loads(manifest.read_text())
        value['extensions']['com.openai']['interface']['logo'] = './../secret.png'
        manifest.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, 'escaping'):
            package.validate(self.root)
        with self.assertRaisesRegex(ValueError, 'escaping'):
            package.checked_path(self.root, './../secret.png')

    def test_rejects_missing_portable_manifest(self):
        (self.root / 'plugin.json').unlink()
        with self.assertRaisesRegex(ValueError, 'Missing manifest'):
            package.validate(self.root)

    def test_rejects_non_objects_and_missing_required_fields(self):
        """Validate malformed copies of actual manifests across required boundaries."""
        path = self.root / 'plugin.json'
        original = path.read_text()
        settings = ('extensions', 'com.openai')
        paths = [('description',), ('extensions',), settings, (*settings, 'interface'),
                 (*settings, 'onboardingSkill'), (*settings, 'interface', 'composerIcon'),
                 (*settings, 'interface', 'logo')]
        mutations = [None, [], 'invalid', 123, *paths,
                     *((keys, []) for keys in paths if keys[-1] in ('extensions', 'com.openai', 'interface'))]
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                value = json.loads(original)
                if isinstance(mutation, tuple):
                    keys = mutation[0] if isinstance(mutation[0], tuple) else mutation
                    mapping = value
                    for key in keys[:-1]:
                        mapping = mapping[key]
                    if isinstance(mutation[0], tuple):
                        mapping[keys[-1]] = mutation[1]
                    else:
                        del mapping[keys[-1]]
                else:
                    value = mutation
                path.write_text(json.dumps(value))
                try:
                    with self.assertRaises(ValueError):
                        package.validate(self.root)
                finally:
                    path.write_text(original)

    @unittest.skipUnless(shutil.which('make'), 'Make is not installed')
    def test_make_targets_use_configured_python(self):
        """Select the same interpreter across real and recursive plugin recipes."""
        root = Path(self.temp.name) / 'make-python'
        shutil.copytree(self.root, root / 'plugins/boxlite-codex')
        shutil.copytree(self.claude, root / 'plugins/boxlite-claude')
        (root / 'scripts/plugins').mkdir(parents=True)
        shutil.copyfile(REPO / 'scripts/plugins/boxlite.py', root / 'scripts/plugins/boxlite.py')
        (root / 'tests/plugins').mkdir(parents=True)
        (root / 'tests/plugins/test_package.py').write_text(
            'import unittest\nfrom scripts.plugins.boxlite import validate\n'
            'class PackageBoundary(unittest.TestCase):\n'
            '    def test_validate(self):\n        self.assertTrue(validate())\n')
        workaround = (REPO / 'Makefile').read_text().split('# Workaround for macOS', 1)[1]
        (root / 'Makefile').write_text(
            f'include {REPO / "make/test.mk"}\ninclude {REPO / "make/plugins.mk"}\n.PHONY: $(PHONY_TARGETS)\n# Workaround for macOS'
            + workaround)
        log = root / 'python-invocations'
        interpreter = root / 'selected-python'
        interpreter.write_text(
            '#!/bin/sh\n'
            f'printf \'%s\\n\' "$*" >> {shlex.quote(str(log))}\n'
            f'exec {shlex.quote(sys.executable)} "$@"\n')
        interpreter.chmod(0o755)
        # Each isolated Make fixture supplies its own interpreter contract.
        environment = os.environ.copy()
        for key in ('MAKEFLAGS', 'MFLAGS', 'MAKEOVERRIDES', 'PLUGIN_PYTHON',
                    'PLUGIN_COVERAGE_PYTHON'):
            environment.pop(key, None)
        unit = "-m unittest discover -s tests/plugins -p test_*.py"
        cases = {
            'test:unit:plugins': [unit],
            'plugin:boxlite:check': ['scripts/plugins/boxlite.py check', unit],
            'plugin:boxlite:dist': ['scripts/plugins/boxlite.py check', unit,
                                   'scripts/plugins/boxlite.py dist'],
        }
        for target, expected in cases.items():
            with self.subTest(target=target):
                log.write_text('')
                result = subprocess.run(['make', '--no-print-directory', target,
                                         f'PLUGIN_PYTHON={interpreter}'], cwd=root,
                                        env=environment, capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertEqual(log.read_text().splitlines(), expected)
        for override in (None, root / 'coverage-python'):
            with self.subTest(coverage_override=override):
                command = ['make', '--no-print-directory', '-n', 'plugin:boxlite:coverage',
                           f'PLUGIN_PYTHON={interpreter}']
                if override is not None:
                    command.append(f'PLUGIN_COVERAGE_PYTHON={override}')
                result = subprocess.run(command, cwd=root, env=environment,
                                        capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                coverage = [line for line in result.stdout.splitlines() if ' -m coverage ' in line]
                self.assertEqual(len(coverage), 5, result.stdout)
                for line in coverage:
                    self.assertIn(f'{override or interpreter} -m coverage ', line)

    @unittest.skipUnless(shutil.which('make'), 'Make is not installed')
    def test_make_claude_strict_validation_and_failure_propagation(self):
        """Reach both CLI boundaries with real packaging, stopping on source failure."""
        root = Path(self.temp.name) / 'make-claude'
        shutil.copytree(self.root, root / 'plugins/boxlite-codex')
        shutil.copytree(self.claude, root / 'plugins/boxlite-claude')
        (root / 'scripts/plugins').mkdir(parents=True)
        shutil.copyfile(REPO / 'scripts/plugins/boxlite.py', root / 'scripts/plugins/boxlite.py')
        (root / 'tests/plugins').mkdir(parents=True)
        (root / 'tests/plugins/test_package.py').write_text(
            'import unittest\nfrom scripts.plugins.boxlite import validate\n'
            'class PackageBoundary(unittest.TestCase):\n'
            '    def test_validate(self):\n        self.assertTrue(validate())\n')
        workaround = (REPO / 'Makefile').read_text().split('# Workaround for macOS', 1)[1]
        (root / 'Makefile').write_text(
            f'include {REPO / "make/test.mk"}\ninclude {REPO / "make/plugins.mk"}\n.PHONY: $(PHONY_TARGETS)\n# Workaround for macOS'
            + workaround)
        log = root / 'claude-invocations'
        executable = root / 'claude'
        executable.write_text(
            '#!/bin/sh\n'
            f'printf \'%s\\n\' "$*" >> {shlex.quote(str(log))}\n'
            'if [ "$4" = "plugins/boxlite-claude" ]; then\n'
            '    exit "$CLAUDE_TEST_SOURCE_STATUS"\n'
            'fi\nexit 0\n')
        executable.chmod(0o755)
        environment = os.environ.copy()
        for key in ('MAKEFLAGS', 'MFLAGS', 'MAKEOVERRIDES', 'PLUGIN_PYTHON',
                    'PLUGIN_COVERAGE_PYTHON'):
            environment.pop(key, None)
        environment['PATH'] = str(root) + os.pathsep + environment.get('PATH', '')
        expected = ['plugin validate --strict plugins/boxlite-claude',
                    'plugin validate --strict target/plugins/boxlite-marketplace']
        for source_status in (0, 7):
            with self.subTest(source_status=source_status):
                log.write_text('')
                environment['CLAUDE_TEST_SOURCE_STATUS'] = str(source_status)
                result = subprocess.run(
                    ['make', '--no-print-directory', 'plugin:boxlite:check:cc',
                     f'PLUGIN_PYTHON={sys.executable}'], cwd=root, env=environment,
                    capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0 if source_status == 0 else 2,
                                 result.stdout + result.stderr)
                self.assertEqual(log.read_text().splitlines(),
                                 expected if source_status == 0 else expected[:1])
                self.assertTrue((root / 'target/plugins/boxlite-marketplace'
                                 '/.claude-plugin/marketplace.json').exists())

    @unittest.skipUnless(shutil.which('make'), 'Make is not installed')
    def test_make_targets_validate_with_same_named_files(self):
        """Run real Make recipes despite target-name collisions in the filesystem."""
        root = Path(self.temp.name) / 'make-work'
        shutil.copytree(self.root, root / 'plugins/boxlite-codex')
        shutil.copytree(self.claude, root / 'plugins/boxlite-claude')
        (root / 'scripts/plugins').mkdir(parents=True)
        shutil.copyfile(REPO / 'scripts/plugins/boxlite.py', root / 'scripts/plugins/boxlite.py')
        (root / 'tests/plugins').mkdir(parents=True)
        (root / 'plugins/boxlite-codex/plugin.json').write_text('{}')
        workaround = (REPO / 'Makefile').read_text().split('# Workaround for macOS', 1)[1]
        (root / 'Makefile').write_text(
            f'include {REPO / "make/test.mk"}\ninclude {REPO / "make/plugins.mk"}\n.PHONY: $(PHONY_TARGETS)\n# Workaround for macOS'
            + workaround)
        for target in ('plugin:boxlite:check', 'plugin:boxlite:dist', 'plugin:boxlite:check:cc'):
            (root / target).touch()
        for target in ('plugin:boxlite:check', 'plugin:boxlite:dist', 'plugin:boxlite:check:cc'):
            with self.subTest(target=target):
                result = subprocess.run(['make', '--no-print-directory', target,
                                         f'PLUGIN_PYTHON={sys.executable}'], cwd=root,
                                        capture_output=True, text=True, timeout=30)
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn('Expected portable Agent Plugins schema', result.stderr)


if __name__ == '__main__':
    unittest.main()
