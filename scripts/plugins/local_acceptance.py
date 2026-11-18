#!/usr/bin/env python3
"""Exercise the packaged Local launcher against an actual embedded VM."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request
import uuid

REPO = Path(__file__).resolve().parents[2]
LAUNCHER = REPO / 'plugins/boxlite/skills/boxlite/scripts/local.py'


def exercise(cli, workspace, report):
    home = workspace / 'runtime'
    configuration = workspace / 'local.json'
    configuration.write_text(json.dumps({'mode': 'local', 'cli': str(cli), 'home': str(home)}))
    configuration.chmod(0o600)
    # Conflicting inherited routing must not turn a Local workload into a cloud call.
    environment = dict(os.environ, BOXLITE_REST_URL='http://127.0.0.1:1',
                       BOXLITE_API_KEY='synthetic-local-isolation-check', BOXLITE_CONTEXT='invalid-context',
                       BOXLITE_PROFILE='invalid-profile', BOXLITE_HOME=str(workspace / 'wrong-home'),
                       BOXLITE_REST_PATH_PREFIX='invalid-prefix')

    def command(*arguments, expected=0):
        result = subprocess.run([sys.executable, str(LAUNCHER), str(configuration), '--', *arguments],
                                env=environment, capture_output=True, text=True, timeout=620)
        report['commands'].append({'arguments': list(arguments), 'exit_code': result.returncode,
                                   'stdout': result.stdout[-4096:], 'stderr': result.stderr[-4096:]})
        if expected is None:
            if result.returncode == 0:
                raise RuntimeError(f'{arguments[0]} unexpectedly succeeded')
        elif result.returncode != expected:
            raise RuntimeError(f'{arguments[0]} returned {result.returncode}, expected {expected}')
        return result.stdout.strip()

    if json.loads(command('list', '--all', '--format', 'json')) != []:
        raise RuntimeError('Fresh Local runtime unexpectedly contains Boxes')
    report['checks'].append('embedded-runtime-with-conflicting-cloud-environment')
    command('list', '--url=http://127.0.0.1:1', expected=2)
    report['checks'].append('routing-override-rejected')
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        port = reservation.getsockname()[1]
    # The CLI needs a fixed port. If another process wins the race, fail and clean up; do not retry writes.
    name = 'plugin-local-' + uuid.uuid4().hex[:12]
    report['resource_name'] = name
    box = None
    try:
        box = command('create', '--name', name, '--cpus', '1', '--memory', '256', '--inbound', 'enabled',
                      '-p', f'{port}:8000', 'python:3.11-alpine', '/bin/sleep', '600')
        if not box or len(box.splitlines()) != 1:
            box = None
            raise RuntimeError('Creation did not return one Box ID; inspect the recorded resource name')
        report['box_id'] = box
        command('start', box)
        if command('exec', box, '--', '/bin/echo', 'hello') != 'hello':
            raise RuntimeError('Hello output mismatch')
        command('exec', box, '--', '/bin/sh', '-c', 'exit 7', expected=7)
        report['checks'] += ['create-start-execute', 'nonzero-exit-preserved']
        directory = '/workspace/plugin-check'
        command('exec', box, '--', '/bin/mkdir', '-p', directory)
        source = workspace / 'message.txt'
        downloaded = workspace / 'downloaded.txt'
        source.write_bytes(b'version-one\n')
        destination = f'{box}:{directory}/message.txt'
        command('cp', str(source), destination)
        command('cp', destination, str(downloaded))
        if downloaded.read_bytes() != b'version-one\n':
            raise RuntimeError('File roundtrip mismatch')
        report['checks'].append('file-roundtrip')
        source.write_bytes(b'forbidden-overwrite\n')
        command('cp', '--no-overwrite', str(source), destination, expected=None)
        command('cp', destination, str(downloaded))
        if downloaded.read_bytes() != b'version-one\n':
            raise RuntimeError('Overwrite refusal did not preserve original data')
        report['checks'].append('overwrite-refused-with-data-preserved')
        command('exec', box, '--', 'python3', '--version')
        command('exec', '-d', box, '--', 'python3', '-m', 'http.server', '8000', '--bind', '0.0.0.0', '--directory', directory)
        url = f'http://127.0.0.1:{port}/message.txt'
        report['localhost_url'] = url
        http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

        def verify_http(expected):
            deadline = time.monotonic() + 30
            while True:
                try:
                    with http.open(url, timeout=3) as response:
                        if response.status == 200 and response.read(1024) == expected:
                            return
                except OSError:
                    pass
                if time.monotonic() >= deadline:
                    command('top', box)
                    raise RuntimeError('Localhost did not serve the expected app content')
                time.sleep(0.5)

        verify_http(b'version-one\n')
        report['checks'].append('localhost-app-feature')
        command('exec', box, '--', '/bin/sh', '-c', 'printf keep > /workspace/plugin-check/persistent.txt')
        source.write_bytes(b'version-two\n')
        command('cp', str(source), destination)
        identity = json.loads(command('inspect', box))[0]['Id']
        if identity != box or command('exec', box, '--', '/bin/cat', directory + '/persistent.txt') != 'keep':
            raise RuntimeError('Update changed Box identity or persistent data')
        verify_http(b'version-two\n')
        report['checks'] += ['update-preserves-box-and-data', 'same-localhost-url-serves-update']
        command('stop', box)
        command('start', box)
        if command('exec', box, '--', '/bin/cat', directory + '/persistent.txt') != 'keep':
            raise RuntimeError('Persistent data did not survive stop and start')
        report['checks'].append('stop-start-preserves-data')
    finally:
        if box:
            try:
                command('stop', box)
                command('rm', box)
                remaining = json.loads(command('list', '--all', '--format', 'json'))
                if any(value['ID'] == box for value in remaining):
                    raise RuntimeError('Removed Box remains in the runtime')
                report['cleanup'] = 'passed'
                report['checks'].append('explicit-id-cleanup-verified')
            except Exception:
                report['cleanup'] = 'failed; inspect recorded box_id and runtime_home'
                raise
        else:
            report['cleanup'] = 'creation outcome unknown; inspect recorded resource_name and runtime_home'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cli', required=True, type=Path, help='Verified official BoxLite CLI executable')
    args = parser.parse_args()
    evidence = REPO / 'target/plugins/evidence'
    workspace = evidence / ('local-run-' + uuid.uuid4().hex[:12])
    workspace.mkdir(parents=True, mode=0o700)
    report = {'mode': 'local', 'status': 'failed', 'checks': [], 'commands': [],
              'started_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
              'runtime_home': str(workspace / 'runtime'), 'cli': str(args.cli.resolve())}
    try:
        exercise(args.cli.resolve(), workspace, report)
        report['status'] = 'passed'
    except Exception as error:
        report['failure'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
    output = evidence / 'local.json'
    with os.fdopen(os.open(output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as stream:
        os.fchmod(stream.fileno(), 0o600)
        json.dump(report, stream, indent=2)
    print(f"Local runtime acceptance: {report['status']}; private evidence: {output.relative_to(REPO)}")
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
