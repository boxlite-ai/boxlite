#!/usr/bin/env python3
"""Stage, build and restart an app in an existing Box using its private config."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import time
import uuid
import urllib.request

EXCLUDE = {'.git', '.boxlite', '.venv', 'venv', 'node_modules', '__pycache__',
           '.next', 'dist', 'target', 'data', 'uploads', 'credentials.toml', 'secrets.json'}


def package(source, output):
    with tarfile.open(output, 'w:gz') as archive:
        for root, directories, files in os.walk(source, followlinks=False):
            directories[:] = [name for name in directories if name not in EXCLUDE and not name.startswith('.env')]
            for name in [*directories, *files]:
                path = Path(root) / name
                if name in EXCLUDE or name.startswith('.env') or path.suffix in ('.pem', '.key', '.p12', '.db', '.sqlite', '.sqlite3'):
                    continue
                if path.is_symlink():
                    raise ValueError('Source symlinks require an explicitly reviewed artifact layout')
                if not path.is_file() and not path.is_dir():
                    raise ValueError('Only regular source files and directories can be uploaded')
                archive.add(path, arcname=path.relative_to(source), recursive=False)


def deploy(config_path):
    config = json.loads(config_path.read_text())
    source = (config_path.parent / config['source']).resolve()
    root = config.get('remote_root', '/workspace/boxlite-app')
    port = config['port']
    if not source.is_dir() or not re.fullmatch(r'/workspace/[A-Za-z0-9_-]+', root):
        raise ValueError('Source directory or remote workspace root is invalid')
    if not isinstance(port, int) or isinstance(port, bool) or not 1 <= port <= 65535:
        raise ValueError('Port must be an integer between 1 and 65535')
    health_path = config.get('health_path', '/health')
    if not isinstance(health_path, str) or not health_path.startswith('/') or any(c in health_path for c in ('?', '#', '\r', '\n')):
        raise ValueError('Health path must be a plain absolute HTTP path')
    cli = [config.get('cli', 'boxlite'), '--profile', config['profile']]
    if config.get('home'):
        cli += ['--home', config['home']]
    if config.get('api_url'):
        cli += ['--url', config['api_url']]
    box = config['box']
    if os.environ.get('BOXLITE_API_KEY'):
        raise ValueError('An environment API key overrides profiles; resolve the selected credential source first')
    commands = [config['start'], *config.get('build', [])]
    if any(not isinstance(c, list) or not c or any(not isinstance(a, str) or '\0' in a for a in c) for c in commands):
        raise ValueError('Commands must be nonempty argv arrays')

    def run(*args, timeout=60):
        try:
            result = subprocess.run([*cli, *args], capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            raise RuntimeError(f'CLI {args[0]} timed out; inspect that operation before retrying') from None
        if result.returncode:
            raise RuntimeError(f'CLI {args[0]} failed; inspect that operation with the selected profile')
        return result.stdout

    release = root + '/releases/' + uuid.uuid4().hex
    app = release + '/app'
    shared = root + '/shared'
    with tempfile.TemporaryDirectory(prefix='boxlite-deploy-') as temporary:
        temporary = Path(temporary)
        archive = temporary / 'source.tgz'
        package(source, archive)
        remote = {'cwd': app, 'build_state_dir': release, 'state_dir': shared, 'start': config['start'],
                  'build': config.get('build', []), 'health_url': f'http://127.0.0.1:{port}{health_path}',
                  'build_timeout': config.get('build_timeout', 900), 'health_timeout': config.get('health_timeout', 30)}
        controller_config = temporary / 'config.json'
        controller_config.write_text(json.dumps(remote))
        os.chmod(controller_config, 0o600)
        run('exec', box, '--', 'mkdir', '-p', app, shared, root + '/data')
        run('exec', box, '--', 'chmod', '700', shared)
        run('cp', str(archive), box + ':' + release + '/source.tgz', timeout=300)
        run('cp', str(Path(__file__).with_name('service.py')), box + ':' + shared + '/service.py')
        run('cp', str(controller_config), box + ':' + release + '/config.json')
        run('exec', box, '--', 'tar', '-xzf', release + '/source.tgz', '-C', app, timeout=300)
        run('exec', '-d', box, '--', 'python3', shared + '/service.py', 'build', release + '/config.json')
        deadline = time.monotonic() + remote['build_timeout'] + 60
        while True:
            status = run('exec', box, '--', 'python3', '-c',
                         'from pathlib import Path; import sys; p=Path(sys.argv[1]); print(p.read_text() if p.exists() else "pending")', release + '/build.exit').strip()
            if status != 'pending':
                if status != '0':
                    raise RuntimeError('Build failed; current service preserved. Inspect release/build.log')
                break
            if time.monotonic() >= deadline:
                raise RuntimeError('Build status deadline expired; inspect release before retrying')
            time.sleep(2)
        service = json.loads(run('exec', box, '--', 'python3', shared + '/service.py', 'restart', release + '/config.json'))
        urls = re.findall(r'https://[^\s]+', run('network', 'tunnel', box, str(port)))
        if len(urls) != 1:
            raise RuntimeError('Tunnel did not return one HTTPS URL; application URL is pending')
        try:
            with urllib.request.urlopen(urls[0].rstrip('/') + health_path, timeout=30) as response:
                if response.status != 200:
                    raise OSError('Unexpected health status')
        except OSError:
            raise RuntimeError('Public health check failed; inspect the registered tunnel and app') from None
        print(json.dumps({'url': urls[0], 'release': release, 'pid': service['pid'], 'guest_health': 'passed', 'public_health': 'passed'}))


if __name__ == '__main__':
    if len(sys.argv) != 2:
        raise SystemExit('Usage: deploy.py PRIVATE_DEPLOYMENT.json')
    os.umask(0o077)
    try:
        deploy(Path(sys.argv[1]).resolve())
    except Exception as error:
        print(str(error) if isinstance(error, (ValueError, RuntimeError)) else 'Deployment failed; inspect private operation logs', file=sys.stderr)
        raise SystemExit(1)
