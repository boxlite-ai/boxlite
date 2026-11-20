#!/usr/bin/env python3
"""Validate and reproducibly package BoxLite's cloud MCP and local workflows."""
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
MCP_URL = 'https://api.boxlite.ai/mcp'
INVENTORY = {
    'plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json',
    'mcp.json', '.mcp.json', 'README.md', 'LICENSE', 'assets/boxlite-icon.png',
    'skills/boxlite/SKILL.md', 'skills/boxlite/agents/openai.yaml',
    'skills/boxlite/references/cloud.md', 'skills/boxlite/references/local.md',
    'skills/boxlite/scripts/local.py', 'skills/boxlite-setup/SKILL.md',
    'skills/boxlite-setup/agents/openai.yaml', 'skills/boxlite-setup/references/cloud-auth.md',
}


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
    version = manifest.get('version')
    if manifest.get('name') != 'boxlite' or not isinstance(version, str) or not re.fullmatch(r'(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', version):
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
    if legacy.get('mcpServers') != './.mcp.json':
        raise ValueError('Compatibility MCP path differs')
    onboarding = required_field(settings, 'onboardingSkill', 'OpenAI extension')
    legacy_extensions = required_field(legacy, 'extensions', 'Codex manifest')
    legacy_settings = required_field(legacy_extensions, 'com.openai', 'Codex extensions')
    if required_field(legacy_settings, 'onboardingSkill', 'Codex OpenAI extension') != onboarding:
        raise ValueError('Compatibility onboarding differs')
    for field in ('composerIcon', 'logo'):
        checked_path(root, required_field(interface, field, 'OpenAI interface'))
    for filename, transport in (('mcp.json', 'streamable-http'), ('.mcp.json', 'http')):
        expected = {'mcpServers': {'boxlite': {'type': transport, 'url': MCP_URL}}}
        if filename == 'mcp.json':
            expected['$schema'] = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'
        if load_manifest(root, filename) != expected:
            raise ValueError(f'Invalid MCP declaration: {filename}; only the production endpoint is distributable')
    skills = [path for path in files if path.name == 'SKILL.md' and path.parent.parent == root / 'skills']
    if not skills:
        raise ValueError('No skills packaged')
    if checked_path(root, onboarding) not in skills:
        raise ValueError('Onboarding must name a packaged skill')
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
        if path.suffix in {'.json', '.md', '.py', '.yaml'} and re.search(r'\bblk_[A-Za-z0-9_-]{16,}', path.read_text()):
            raise ValueError('Credential material is not distributable')
    if {path.relative_to(root).as_posix() for path in files} != INVENTORY:
        raise ValueError('Package inventory differs: missing or undeclared files')
    return files


def write_zip(archive, root, files):
    """Use stable ordering, timestamps, permissions, and paths for either archive."""
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as zipped:
        for path in sorted(files):
            info = zipfile.ZipInfo(path.relative_to(root).as_posix(), (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0o100644 << 16
            zipped.writestr(info, path.read_bytes())


def build(output, root=PLUGIN):
    """Validate and stage a deterministic ZIP, host marketplaces, and SHA-256 digest."""
    files = validate(root)
    output.mkdir(parents=True, exist_ok=True)
    version = load_manifest(root, 'plugin.json')['version']
    archive = output / f'boxlite-{version}.zip'
    write_zip(archive, root, files)
    marketplace = output / 'boxlite-marketplace'
    if marketplace.exists():
        shutil.rmtree(marketplace)
    staged = marketplace / 'plugins/boxlite'
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
        'name': 'boxlite', 'description': 'BoxLite cloud MCP and independent local runtime.',
        'owner': {'name': 'BoxLite'}, 'plugins': [{
            'name': 'boxlite', 'source': './plugins/boxlite',
            'description': load_manifest(root, 'plugin.json')['description'],
        }],
    }, indent=2) + '\n')
    marketplace_zip = output / f'boxlite-marketplace-{version}.zip'
    write_zip(marketplace_zip, marketplace, [path for path in marketplace.rglob('*') if path.is_file()])
    (output / 'SHA256SUMS').write_text(''.join(
        f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n'
        for path in (archive, marketplace_zip)))
    return archive


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'dist'])
    args = parser.parse_args()
    if args.action == 'check':
        print(f'BoxLite package validated: {len(validate())} source files')
    else:
        print(build(REPO / 'target/plugins'))
