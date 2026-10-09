import importlib.util
import json
import shutil
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
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'plugin'
        for source in package.package_files(package.PLUGIN):
            target = self.root / source.relative_to(package.PLUGIN)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)

    def test_archive_excludes_caches_and_installs_from_standalone_marketplace(self):
        cache = self.root / 'node_modules/private.js'
        cache.parent.mkdir(parents=True)
        cache.write_text('cache')
        output = Path(self.temp.name) / 'output'
        archive = package.build(output, self.root)
        with zipfile.ZipFile(archive) as zipped:
            self.assertIn('plugin.json', zipped.namelist())
            self.assertIn('skills/boxlite/SKILL.md', zipped.namelist())
            self.assertFalse(any('node_modules' in name for name in zipped.namelist()))
            self.assertFalse(any(name.startswith('templates/') for name in zipped.namelist()))
        catalog = json.loads((output / 'boxlite-marketplace/.agents/plugins/marketplace.json').read_text())
        target = output / 'boxlite-marketplace' / catalog['plugins'][0]['source']['path']
        self.assertTrue((target / 'plugin.json').exists())
        self.assertEqual(archive.read_bytes(), package.build(output, self.root).read_bytes())

    def test_rejects_private_deployment_state(self):
        (self.root / 'deployment.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'Private state'):
            package.validate(self.root)

    def test_rejects_symlink_and_manifest_path_escape(self):
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


if __name__ == '__main__':
    unittest.main()
