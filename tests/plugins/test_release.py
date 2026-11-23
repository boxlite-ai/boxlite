"""Verify review handoff reproducibility and fail-closed release evidence."""
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts/plugins'))
import release


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.output = Path(temporary.name)
        self.checklist = self.output / 'private-checklist.json'
        self.value = json.loads((release.REVIEW / 'checklist.json').read_text())

    def save(self):
        self.checklist.write_text(json.dumps(self.value))

    def test_review_kit_excludes_private_evidence_and_stale_files(self):
        archive = release.review_kit(self.output)
        first = archive.read_bytes()
        (self.output / 'review-kit/private-state.json').write_text('must not be shipped')
        private = self.output / 'evidence'
        private.mkdir()
        (private / 'cloud-api.json').write_text('must not be shipped')
        self.assertEqual(first, release.review_kit(self.output).read_bytes())
        with zipfile.ZipFile(archive) as zipped:
            self.assertEqual(set(zipped.namelist()), set(release.MATERIALS) | {
                'SHA256SUMS', 'boxlite-0.2.0.zip', 'boxlite-marketplace-0.2.0.zip'})
            for line in zipped.read('SHA256SUMS').decode().splitlines():
                digest, name = line.split()
                self.assertEqual(digest, hashlib.sha256(zipped.read(name)).hexdigest())
        self.assertEqual(archive.with_suffix('.zip.sha256').read_text().split()[0], hashlib.sha256(first).hexdigest())

    def test_default_checklist_never_claims_ready(self):
        self.save()
        missing = release.readiness(self.checklist, self.output)
        self.assertTrue(set(self.value['gates']).issubset(missing))

    def test_gate_requires_evidence_and_the_actual_artifact_hashes(self):
        release.build(self.output)
        for gate in self.value['gates'].values():
            gate.update(status='passed', evidence='synthetic-evidence-reference')
        self.value['artifact_sha256'] = {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                                         for path in self.output.glob('*.zip')}
        self.save()
        self.assertEqual(release.readiness(self.checklist, self.output), [])
        self.value['gates']['oauth_host_workflow']['evidence'] = ' '
        self.save()
        self.assertIn('oauth_host_workflow', release.readiness(self.checklist, self.output))
        (self.output / 'boxlite-0.2.0.zip').write_bytes(b'changed artifact')
        self.assertIn('verified hash: boxlite-0.2.0.zip', release.readiness(self.checklist, self.output))

    def test_deleting_a_gate_or_mismatching_version_is_not_a_bypass(self):
        original = json.loads(json.dumps(self.value))
        del self.value['gates']['local_runtime_workflow']
        self.save()
        with self.assertRaisesRegex(ValueError, 'every required gate'):
            release.readiness(self.checklist, self.output)
        self.value = original
        self.value['version'] = '0.1.0'
        self.save()
        with self.assertRaisesRegex(ValueError, 'version'):
            release.readiness(self.checklist, self.output)
