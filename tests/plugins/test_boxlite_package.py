import importlib.util
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
            self.assertIn('plugin.json', zipped.namelist())
            self.assertIn('skills/boxlite/SKILL.md', zipped.namelist())
            self.assertIn('.claude-plugin/plugin.json', zipped.namelist())
            self.assertFalse(any('node_modules' in name for name in zipped.namelist()))
            self.assertFalse(any(name.startswith('templates/') for name in zipped.namelist()))
        catalog = json.loads((output / 'boxlite-marketplace/.agents/plugins/marketplace.json').read_text())
        target = output / 'boxlite-marketplace' / catalog['plugins'][0]['source']['path']
        self.assertTrue((target / 'plugin.json').exists())
        claude_catalog = json.loads((output / 'boxlite-marketplace/.claude-plugin/marketplace.json').read_text())
        claude_target = output / 'boxlite-marketplace' / claude_catalog['plugins'][0]['source']
        self.assertEqual(target.resolve(), claude_target.resolve())
        self.assertTrue((claude_target / '.claude-plugin/plugin.json').exists())
        self.assertEqual(archive.read_bytes(), package.build(output, self.root).read_bytes())

    def test_rejects_claude_manifest_identity_drift(self):
        """Reject drift in each Claude identity field before staging a package."""
        manifest = self.root / '.claude-plugin/plugin.json'
        original = manifest.read_text()
        for key, replacement in (('name', 'another-plugin'), ('version', '0.2.0'),
                                 ('description', 'Another plugin description.')):
            with self.subTest(field=key):
                value = json.loads(original)
                value[key] = replacement
                manifest.write_text(json.dumps(value))
                try:
                    with self.assertRaisesRegex(ValueError, f'Claude compatibility identity differs: {key}'):
                        package.validate(self.root)
                finally:
                    manifest.write_text(original)

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
        """Reject links, cross-manifest drift, and paths outside the package."""
        (self.root / 'outside').symlink_to('/etc/passwd')
        with self.assertRaisesRegex(ValueError, 'Symlink'):
            package.validate(self.root)
        (self.root / 'outside').unlink()
        manifest = self.root / 'plugin.json'
        value = json.loads(manifest.read_text())
        value['extensions']['com.openai']['interface']['logo'] = './../secret.png'
        manifest.write_text(json.dumps(value))
        with self.assertRaisesRegex(ValueError, 'differs'):
            package.validate(self.root)
        with self.assertRaisesRegex(ValueError, 'escaping'):
            package.checked_path(self.root, './../secret.png')

    def test_rejects_missing_manifest_files(self):
        """Report absent required manifests as package validation errors."""
        for relative in ('plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json'):
            path = self.root / relative
            original = path.read_bytes()
            with self.subTest(manifest=relative):
                path.unlink()
                try:
                    with self.assertRaisesRegex(ValueError, 'Missing manifest'):
                        package.validate(self.root)
                finally:
                    path.write_bytes(original)

    def test_rejects_non_objects_and_missing_required_fields(self):
        """Validate malformed copies of actual manifests across required boundaries."""
        fields = {
            'plugin.json': [('description',), ('extensions',), ('extensions', 'com.openai'),
                            ('extensions', 'com.openai', 'interface'),
                            ('extensions', 'com.openai', 'onboardingSkill')],
            '.codex-plugin/plugin.json': [(key,) for key in ('name', 'version', 'description', 'interface')],
            '.claude-plugin/plugin.json': [(key,) for key in ('name', 'version', 'description')],
        }
        fields['plugin.json'] += [('extensions', 'com.openai', 'interface', key)
                                  for key in ('composerIcon', 'logo')]
        for relative, paths in fields.items():
            path = self.root / relative
            original = path.read_text()
            mutations = [None, [], 'invalid', 123, *paths,
                         *((keys, []) for keys in paths if keys[-1] in ('extensions', 'com.openai', 'interface'))]
            for mutation in mutations:
                with self.subTest(manifest=relative, mutation=mutation):
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
        shutil.copytree(self.root, root / 'plugins/boxlite')
        (root / 'scripts/plugins').mkdir(parents=True)
        shutil.copyfile(REPO / 'scripts/plugins/boxlite.py', root / 'scripts/plugins/boxlite.py')
        (root / 'tests/plugins').mkdir(parents=True)
        (root / 'tests/plugins/test_package.py').write_text(
            'import unittest\nfrom scripts.plugins.boxlite import validate\n'
            'class PackageBoundary(unittest.TestCase):\n'
            '    def test_validate(self):\n        self.assertTrue(validate())\n')
        workaround = (REPO / 'Makefile').read_text().split('# Workaround for macOS', 1)[1]
        (root / 'Makefile').write_text(
            f'include {REPO / "make/plugins.mk"}\n.PHONY: $(PHONY_TARGETS)\n# Workaround for macOS'
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
        shutil.copytree(self.root, root / 'plugins/boxlite')
        (root / 'scripts/plugins').mkdir(parents=True)
        shutil.copyfile(REPO / 'scripts/plugins/boxlite.py', root / 'scripts/plugins/boxlite.py')
        (root / 'tests/plugins').mkdir(parents=True)
        (root / 'tests/plugins/test_package.py').write_text(
            'import unittest\nfrom scripts.plugins.boxlite import validate\n'
            'class PackageBoundary(unittest.TestCase):\n'
            '    def test_validate(self):\n        self.assertTrue(validate())\n')
        workaround = (REPO / 'Makefile').read_text().split('# Workaround for macOS', 1)[1]
        (root / 'Makefile').write_text(
            f'include {REPO / "make/plugins.mk"}\n.PHONY: $(PHONY_TARGETS)\n# Workaround for macOS'
            + workaround)
        log = root / 'claude-invocations'
        executable = root / 'claude'
        executable.write_text(
            '#!/bin/sh\n'
            f'printf \'%s\\n\' "$*" >> {shlex.quote(str(log))}\n'
            'if [ "$4" = "plugins/boxlite" ]; then\n'
            '    exit "$CLAUDE_TEST_SOURCE_STATUS"\n'
            'fi\nexit 0\n')
        executable.chmod(0o755)
        environment = os.environ.copy()
        for key in ('MAKEFLAGS', 'MFLAGS', 'MAKEOVERRIDES', 'PLUGIN_PYTHON',
                    'PLUGIN_COVERAGE_PYTHON'):
            environment.pop(key, None)
        environment['PATH'] = str(root) + os.pathsep + environment.get('PATH', '')
        expected = ['plugin validate --strict plugins/boxlite',
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
        shutil.copytree(self.root, root / 'plugins/boxlite')
        (root / 'scripts/plugins').mkdir(parents=True)
        shutil.copyfile(REPO / 'scripts/plugins/boxlite.py', root / 'scripts/plugins/boxlite.py')
        (root / 'tests/plugins').mkdir(parents=True)
        (root / 'plugins/boxlite/plugin.json').write_text('{}')
        workaround = (REPO / 'Makefile').read_text().split('# Workaround for macOS', 1)[1]
        (root / 'Makefile').write_text(
            f'include {REPO / "make/plugins.mk"}\n.PHONY: $(PHONY_TARGETS)\n# Workaround for macOS'
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
