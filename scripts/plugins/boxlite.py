#!/usr/bin/env python3
"""Validate and package the skills-only BoxLite plugin without local state."""
import argparse
import hashlib
import json
import re
import shutil
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PLUGIN = REPO / 'plugins/boxlite'
CACHE = {'node_modules', '.venv', '__pycache__', 'dist', 'public'}
PRIVATE = {'deployment.json', 'credentials.toml', 'secrets.json', 'supervisor.conf', 'data'}


def package_files(root):
    """Yield distributable files, excluding caches and rejecting private state/links."""
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root)
        if CACHE.intersection(relative.parts) or path.suffix == '.tsbuildinfo':
            continue
        if path.is_symlink():
            raise ValueError(f'Symlink is not distributable: {relative}')
        if any(part in PRIVATE or part.startswith('.env') for part in relative.parts):
            raise ValueError(f'Private state in plugin: {relative}')
        if path.is_file():
            yield path


def checked_path(root, value):
    """Resolve a ./-prefixed manifest file within the plugin root or raise ValueError."""
    if not isinstance(value, str) or not value.startswith('./'):
        raise ValueError('Manifest paths must be ./-prefixed')
    path = root / value
    if not path.resolve().is_relative_to(root.resolve()) or not path.is_file():
        raise ValueError(f'Missing or escaping manifest path: {value}')
    return path


def load_manifest(root, relative):
    """Load a required JSON object; absent files and non-objects are invalid packages."""
    try:
        value = json.loads((root / relative).read_text())
    except FileNotFoundError as error:
        raise ValueError(f'Missing manifest file: {relative}') from error
    if not isinstance(value, dict):
        raise ValueError(f'Manifest must be an object: {relative}')
    return value


def required_field(mapping, key, label):
    """Read a required object field with a contextual package validation error."""
    if not isinstance(mapping, dict) or key not in mapping:
        raise ValueError(f'Missing {label} field: {key}')
    return mapping[key]


def validate(root=PLUGIN):
    """Return package files after validating manifests, skills, and package boundaries."""
    files = list(package_files(root))
    manifest = load_manifest(root, 'plugin.json')
    if manifest.get('$schema') != 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json':
        raise ValueError('Expected portable Agent Plugins schema')
    if manifest.get('name') != 'boxlite' or manifest.get('version') != '0.1.0':
        raise ValueError('Unexpected plugin identity/version')
    legacy = load_manifest(root, '.codex-plugin/plugin.json')
    for key in ('name', 'version', 'description'):
        if required_field(manifest, key, 'portable manifest') != required_field(legacy, key, 'Codex manifest'):
            raise ValueError(f'Compatibility identity differs: {key}')
    claude = load_manifest(root, '.claude-plugin/plugin.json')
    for key in ('name', 'version', 'description'):
        if required_field(manifest, key, 'portable manifest') != required_field(claude, key, 'Claude manifest'):
            raise ValueError(f'Claude compatibility identity differs: {key}')
    extensions = required_field(manifest, 'extensions', 'portable manifest')
    settings = required_field(extensions, 'com.openai', 'extensions')
    interface = required_field(settings, 'interface', 'OpenAI extension')
    if interface != required_field(legacy, 'interface', 'Codex manifest'):
        raise ValueError('Compatibility presentation differs')
    if legacy.get('skills') != './skills':
        raise ValueError('Compatibility skill root differs')
    checked_path(root, required_field(settings, 'onboardingSkill', 'OpenAI extension'))
    for field in ('composerIcon', 'logo'):
        checked_path(root, required_field(interface, field, 'OpenAI interface'))
    if (root / 'mcp.json').exists() or (root / 'hooks').exists() or (root / '.mcp.json').exists():
        raise ValueError('v0.1 is skills-only')
    skills = list((root / 'skills').glob('*/SKILL.md'))
    if not skills:
        raise ValueError('No skills packaged')
    for skill in skills:
        text = skill.read_text()
        if not text.startswith('---\n') or '\n---\n' not in text[4:]:
            raise ValueError(f'Invalid skill frontmatter: {skill.name}')
        frontmatter = text.split('---', 2)[1]
        if not re.search(r'^name: [a-z0-9-]+$', frontmatter, re.M) or not re.search(r'^description: .+', frontmatter, re.M):
            raise ValueError('Skill name/description missing')
        if '[TODO' in text:
            raise ValueError('Unfinished skill scaffold')
    for path in files:
        if path.suffix == '.py':
            compile(path.read_text(), str(path), 'exec')
    return files


def build(output, root=PLUGIN):
    """Validate and stage a deterministic ZIP, host marketplaces, and SHA-256 digest."""
    files = validate(root)
    output.mkdir(parents=True, exist_ok=True)
    archive = output / 'boxlite-0.1.0.zip'
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as zipped:
        for path in files:
            info = zipfile.ZipInfo(path.relative_to(root).as_posix(), (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            zipped.writestr(info, path.read_bytes())
    marketplace = output / 'boxlite-marketplace'
    staged = marketplace / 'plugins/boxlite'
    if staged.exists():
        shutil.rmtree(staged)
    for path in files:
        target = staged / path.relative_to(root)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, target)
    catalog = marketplace / '.agents/plugins/marketplace.json'
    catalog.parent.mkdir(parents=True, exist_ok=True)
    catalog.write_text(json.dumps({'name': 'boxlite', 'interface': {'displayName': 'BoxLite'}, 'plugins': [{
        'name': 'boxlite', 'source': {'source': 'local', 'path': './plugins/boxlite'},
        'policy': {'installation': 'AVAILABLE', 'authentication': 'ON_USE'}, 'category': 'Developer Tools',
    }]}, indent=2) + '\n')
    claude_catalog = marketplace / '.claude-plugin/marketplace.json'
    claude_catalog.parent.mkdir(parents=True, exist_ok=True)
    claude_catalog.write_text(json.dumps({
        'name': 'boxlite', 'description': 'BoxLite cloud deployment skills.',
        'owner': {'name': 'BoxLite'}, 'plugins': [{
            'name': 'boxlite', 'source': './plugins/boxlite',
            'description': 'Skills for building and deploying apps on BoxLite cloud.',
        }],
    }, indent=2) + '\n')
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (output / 'SHA256SUMS').write_text(f'{digest}  {archive.name}\n')
    return archive


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'dist'])
    args = parser.parse_args()
    if args.action == 'check':
        print(f'BoxLite package validated: {len(validate())} source files')
    else:
        print(build(REPO / 'target/plugins'))
