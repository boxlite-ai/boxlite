#!/usr/bin/env python3
"""Manage one foreground application in a Linux Box; never signal an unowned PID."""
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import uuid


def validate(config):
    if not Path(config['cwd']).is_dir():
        raise ValueError('Application directory is missing')
    commands = [config['start'], *config.get('build', [])]
    if any(not isinstance(c, list) or not c or any(not isinstance(a, str) or '\0' in a for a in c) for c in commands):
        raise ValueError('Commands must be nonempty argv arrays')
    url = urllib.parse.urlsplit(config['health_url'])
    if url.scheme != 'http' or url.hostname != '127.0.0.1' or not url.port:
        raise ValueError('Health URL must target the guest loopback HTTP port')
    for key, limit, default in [('health_timeout', 45, 30), ('build_timeout', 3600, 900)]:
        value = config.get(key, default)
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not 0 < value <= limit:
            raise ValueError('Operation timeout is outside its supported bounds')


def environment(config):
    env = os.environ.copy()
    path = Path(config['state_dir']) / 'env.json'
    if path.exists():
        if path.stat().st_mode & 0o077:
            raise ValueError('Private environment file must have mode 0600')
        values = json.loads(path.read_text())
        if not isinstance(values, dict) or any(not isinstance(k, str) or not k or '=' in k or '\0' in k or not isinstance(v, str) or '\0' in v for k, v in values.items()):
            raise ValueError('Environment file must map names to strings')
        env.update(values)
    return env


def identity(pid):
    try:
        fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
        return fields[19] if fields[0] != 'Z' else None
    except FileNotFoundError:
        return None


def owned_group(state):
    pid = state['pid']
    current = identity(pid)
    marker = ('BOXLITE_SERVICE_OWNER=' + state['owner']).encode()
    if current is None:
        members = []
        for entry in Path('/proc').glob('[0-9]*'):
            try:
                if os.getpgid(int(entry.name)) == pid and identity(int(entry.name)) is not None:
                    members.append(entry)
            except ProcessLookupError:
                pass  # A process can exit between the /proc scan and group lookup.
        if not members:
            return False
        if not any(marker in (entry / 'environ').read_bytes().split(b'\0') for entry in members):
            raise ValueError('Orphan process group ownership could not be verified')
    elif current != state['identity'] or os.getpgid(pid) != pid or marker not in Path(f'/proc/{pid}/environ').read_bytes().split(b'\0'):
        raise ValueError('Recorded PID is not this managed service; no process was signaled')
    return True


def stop(state):
    if not owned_group(state):
        return
    pid = state['pid']
    os.killpg(pid, signal.SIGTERM)
    deadline = time.monotonic() + 5
    while identity(pid) is not None and time.monotonic() < deadline:
        time.sleep(0.1)
    if owned_group(state):
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass  # The group may finish exiting before SIGKILL reaches it.
        deadline = time.monotonic() + 2
        while owned_group(state):
            if time.monotonic() >= deadline:
                raise RuntimeError('Managed process group did not stop')
            time.sleep(0.1)


def launch(config):
    directory = Path(config['state_dir'])
    owner = uuid.uuid4().hex
    env = environment(config)
    env['BOXLITE_SERVICE_OWNER'] = owner
    port = urllib.parse.urlsplit(config['health_url']).port
    try:
        connection = socket.create_connection(('127.0.0.1', port), timeout=1)
    except OSError:
        pass  # Readiness still verifies that the new service can bind and respond.
    else:
        connection.close()
        raise RuntimeError('Service port is already occupied; no new process was started')
    with (directory / 'app.log').open('ab') as log:
        process = subprocess.Popen(config['start'], cwd=config['cwd'], env=env,
                                   stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                                   start_new_session=True)
    state = {'pid': process.pid, 'identity': identity(process.pid), 'owner': owner, 'config': config}
    try:
        deadline = time.monotonic() + config.get('health_timeout', 30)
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError('Application exited before readiness; inspect app.log')
            try:
                with urllib.request.urlopen(config['health_url'], timeout=1) as response:
                    if response.status == 200 and process.poll() is None:
                        return state
            except (OSError, urllib.error.URLError):
                pass  # Refusal or HTTP failure is retryable only until the health deadline.
            time.sleep(0.2)
        raise RuntimeError('Application health deadline expired; inspect app.log')
    except BaseException:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass  # A failed startup may already have terminated its process group.
        process.wait()
        raise


def execute(action, config):
    validate(config)
    environment(config)  # Fail before stopping the current service.
    directory = Path(config['state_dir'])
    directory.mkdir(parents=True, exist_ok=True)
    os.chmod(directory, 0o700)
    build_directory = Path(config.get('build_state_dir', config['cwd']))
    with ((build_directory / 'build.lock') if action == 'build' else (directory / 'service.lock')).open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        state_path = directory / 'service.json'
        old = json.loads(state_path.read_text()) if state_path.exists() else None
        if action == 'build':
            exit_path = build_directory / 'build.exit'
            exit_path.unlink(missing_ok=True)
            result = 1
            try:
                with (build_directory / 'build.log').open('wb') as log:
                    for argv in config.get('build', []):
                        subprocess.run(argv, cwd=config['cwd'], env=environment(config),
                                       stdout=log, stderr=log, check=True, timeout=config.get('build_timeout', 900))
                result = 0
            finally:
                exit_path.write_text(str(result))
            return
        if old:
            stop(old)
        if action == 'stop':
            state_path.unlink(missing_ok=True)
            return
        try:
            state = launch(config)
        except BaseException:
            if old:
                try:
                    restored = launch(old['config'])
                except BaseException:
                    state_path.unlink(missing_ok=True)
                else:
                    state_path.write_text(json.dumps(restored))
            raise
        state_path.write_text(json.dumps(state))
        os.chmod(state_path, 0o600)
        print(json.dumps({'pid': state['pid'], 'ready': True}))


if __name__ == '__main__':
    os.umask(0o077)
    if len(sys.argv) != 3 or sys.argv[1] not in ('build', 'restart', 'stop'):
        raise SystemExit('Usage: service.py build|restart|stop CONFIG.json')
    try:
        config = json.loads(Path(sys.argv[2]).read_text())
        execute(sys.argv[1], config.get('config', config))
    except Exception as error:
        if sys.argv[1] == 'build':
            Path(sys.argv[2]).with_name('build.exit').write_text('1')
        print(f'{type(error).__name__}: operation failed; inspect private build/app logs', file=sys.stderr)
        raise SystemExit(1)
