#!/usr/bin/env python3
"""Assemble public review materials and check separately maintained release evidence."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

from boxlite import REPO, PLUGIN, build, load_manifest, write_zip

REVIEW = Path(__file__).resolve().parent / 'review'
MATERIALS = ('RELEASE.md', 'REVIEWER.md', 'OAUTH.md', 'cases.json', 'checklist.json')


def review_kit(output):
    build(output)
    version = load_manifest(PLUGIN, 'plugin.json')['version']
    if any(json.loads((REVIEW / name).read_text())['version'] != version for name in ('cases.json', 'checklist.json')):
        raise ValueError('Review material version differs from package')
    staging = output / 'review-kit'
    staging.mkdir(parents=True, exist_ok=True)
    sources = [REVIEW / name for name in MATERIALS]
    sources += [output / f'boxlite-{version}.zip', output / f'boxlite-marketplace-{version}.zip', output / 'SHA256SUMS']
    files = []
    for source in sources:
        target = staging / source.name
        shutil.copyfile(source, target)
        files.append(target)
    archive = output / f'boxlite-review-kit-{version}.zip'
    # Explicit files only: no private evidence or stale staging contents enter the ZIP.
    write_zip(archive, staging, files)
    archive.with_suffix('.zip.sha256').write_text(f'{hashlib.sha256(archive.read_bytes()).hexdigest()}  {archive.name}\n')
    return archive


def readiness(checklist, output):
    template = json.loads((REVIEW / 'checklist.json').read_text())
    value = json.loads(checklist.read_text())
    version = load_manifest(PLUGIN, 'plugin.json')['version']
    if not isinstance(value, dict) or value.get('version') != version:
        raise ValueError('Checklist version differs from package')
    gates = value.get('gates')
    if not isinstance(gates, dict) or set(gates) != set(template['gates']):
        raise ValueError('Checklist must contain every required gate exactly once')
    missing = [name for name, gate in gates.items() if not isinstance(gate, dict)
               or gate.get('status') != 'passed' or not isinstance(gate.get('evidence'), str)
               or not gate['evidence'].strip()]
    hashes = value.get('artifact_sha256', {})
    for name in (f'boxlite-{version}.zip', f'boxlite-marketplace-{version}.zip'):
        artifact = output / name
        if not artifact.is_file() or not isinstance(hashes, dict) or hashes.get(name) != hashlib.sha256(artifact.read_bytes()).hexdigest():
            missing.append('verified hash: ' + name)
    return missing


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('kit', 'ready'))
    parser.add_argument('--checklist', type=Path, default=REVIEW / 'checklist.json')
    args = parser.parse_args()
    output = REPO / 'target/plugins'
    if args.action == 'kit':
        print(review_kit(output))
        return 0
    try:
        missing = readiness(args.checklist, output)
    except (ValueError, OSError):
        print('Submission readiness: blocked; invalid or unreadable checklist')
        return 1
    if missing:
        print('Submission readiness: blocked\n' + '\n'.join('- ' + name for name in missing))
        return 1
    print('Submission readiness: evidence recorded for every gate; release owner must verify the references')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
