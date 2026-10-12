"""Exercise shipped helpers across archive, process, and failure boundaries."""
import fcntl
import importlib.util
import json
import io
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
from contextlib import redirect_stdout
import urllib.request

SCRIPTS = Path(__file__).resolve().parents[2] / 'plugins/boxlite/skills/boxlite/scripts'


def load(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


deploy = load('deploy')
service = load('service')


class ArchiveTests(unittest.TestCase):
    def test_nested_private_files_and_host_dependencies_are_excluded(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'project'
            for name in ['server.py', 'nested/.env.local', 'node_modules/lib.js',
                         '.boxlite/deploy.json', 'data/users.sqlite', 'nested/key.pem', 'nested/code.py']:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('fixture')
            output = Path(temporary) / 'source.tgz'
            deploy.package(root, output)
            with tarfile.open(output) as archive:
                files = {item.name for item in archive if item.isfile()}
            self.assertEqual(files, {'server.py', 'nested/code.py'})

    def test_source_symlink_does_not_copy_external_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'project'
            root.mkdir()
            (root / 'external').symlink_to('/etc/passwd')
            with self.assertRaisesRegex(ValueError, 'symlinks'):
                deploy.package(root, Path(temporary) / 'source.tgz')

    def test_special_file_is_not_uploaded(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / 'project'
            root.mkdir()
            os.mkfifo(root / 'socket-like-pipe')
            with self.assertRaisesRegex(ValueError, 'regular source'):
                deploy.package(root, Path(temporary) / 'source.tgz')

    def test_environment_key_cannot_silently_override_selected_profile(self):
        with tempfile.TemporaryDirectory() as temporary:
            config = Path(temporary) / 'deploy.json'
            config.write_text(json.dumps({'source': '.', 'port': 8000, 'profile': 'selected',
                                          'box': 'app', 'start': ['python3', 'server.py']}))
            with patch.dict(os.environ, {'BOXLITE_API_KEY': 'synthetic-fixture-only'}):
                with self.assertRaisesRegex(ValueError, 'overrides profiles'):
                    deploy.deploy(config)


class DeploymentBoundaryTests(unittest.TestCase):
    def test_successful_cli_boundary_uses_selected_profile_and_only_app_tunnel(self):
        result, calls, copied = self.run_deployment('success')
        self.assertEqual(result['url'], 'https://application.example')
        self.assertEqual(result['pid'], 123)
        self.assertEqual(result['public_health'], 'passed')
        self.assertTrue(all(call[1:3] == ['--profile', 'selected'] for call in calls))
        tunnels = [call for call in calls if call[3] == 'network']
        self.assertEqual(len(tunnels), 1)
        self.assertEqual(tunnels[0][-2:], ['existing-box', '8000'])
        self.assertEqual(copied['source_files'], {'server.py'})
        self.assertEqual(copied['config']['start'], ['python3', 'server.py'])
        self.assertNotEqual(copied['config']['cwd'], '/workspace/boxlite-app/shared')

    def test_explicit_home_and_api_survive_every_cli_operation(self):
        _, calls, _ = self.run_deployment('success', home='/isolated/boxlite-home',
                                          api_url='https://app.boxlite.ai/api')
        for argv in calls:
            self.assertIn('--home', argv)
            self.assertEqual(argv[argv.index('--home') + 1], '/isolated/boxlite-home')
            self.assertEqual(argv[argv.index('--url') + 1], 'https://app.boxlite.ai/api')
            self.assertEqual(argv[argv.index('--profile') + 1], 'selected')

    def test_archive_operations_have_longer_deadlines_without_shortening_restart(self):
        self.run_deployment('success')
        for argv, timeout in zip(self.calls, self.timeouts):
            archive_copy = 'cp' in argv and Path(argv[-2]).name == 'source.tgz'
            extraction = 'tar' in argv
            self.assertEqual(timeout, 300 if archive_copy or extraction else 60)

    def test_cli_timeout_has_safe_operation_error(self):
        with self.assertRaisesRegex(RuntimeError, 'CLI cp timed out'):
            self.run_deployment('timed-out-copy')

    def test_failed_or_unknown_build_never_restarts_running_app(self):
        for mode in ['failed-build', 'unknown-build']:
            with self.subTest(mode=mode):
                with self.assertRaisesRegex(RuntimeError, 'Build'):
                    self.run_deployment(mode)
                self.assertFalse(any('restart' in call for call in self.calls))

    def test_failed_cli_or_public_probe_does_not_report_ready(self):
        for mode in ['failed-copy', 'bad-tunnel', 'failed-public']:
            with self.subTest(mode=mode):
                with self.assertRaises(RuntimeError):
                    self.run_deployment(mode)

    def run_deployment(self, mode, **context):
        self.calls = []
        self.timeouts = []
        copied = {}
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'server.py').write_text('print("app")')
            (root / '.env').write_text('SYNTHETIC_PRIVATE_VALUE=fixture')
            state = root / '.boxlite'
            state.mkdir()
            config = state / 'deploy.json'
            config.write_text(json.dumps({'source': '..', 'port': 8000, 'profile': 'selected',
                                          'box': 'existing-box', 'start': ['python3', 'server.py'], **context}))

            def cli(argv, **kwargs):
                self.calls.append(argv)
                self.timeouts.append(kwargs['timeout'])
                if 'cp' in argv:
                    source = Path(argv[-2])
                    if source.name == 'source.tgz':
                        with tarfile.open(source) as archive:
                            copied['source_files'] = {entry.name for entry in archive if entry.isfile()}
                    elif source.name == 'config.json':
                        copied['config'] = json.loads(source.read_text())
                    if mode == 'timed-out-copy':
                        raise subprocess.TimeoutExpired(argv, kwargs['timeout'])
                    if mode == 'failed-copy':
                        return subprocess.CompletedProcess(argv, 7, '', 'fixture failure')
                output = ''
                if 'network' in argv:
                    output = 'no URL' if mode == 'bad-tunnel' else 'https://application.example'
                elif 'restart' in argv:
                    output = json.dumps({'pid': 123, 'ready': True})
                elif argv[-1].endswith('build.exit'):
                    output = '1' if mode == 'failed-build' else ('pending' if mode == 'unknown-build' else '0')
                return subprocess.CompletedProcess(argv, 0, output, '')

            response = unittest.mock.MagicMock()
            response.__enter__.return_value.status = 200
            http_error = OSError('fixture HTTP failure') if mode == 'failed-public' else None
            with patch.dict(os.environ, {'BOXLITE_API_KEY': ''}), \
                 patch.object(deploy.subprocess, 'run', side_effect=cli), \
                 patch.object(deploy.urllib.request, 'urlopen', return_value=response, side_effect=http_error), \
                 patch.object(deploy.time, 'monotonic', side_effect=[0, 2000] if mode == 'unknown-build' else [0]), \
                 redirect_stdout(io.StringIO()) as output:
                deploy.deploy(config)
            return json.loads(output.getvalue()), self.calls, copied


class ServiceRollbackBoundaryTests(unittest.TestCase):
    def test_failed_rollback_removes_stale_state_and_preserves_original_error(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            shared = root / 'shared'
            shared.mkdir()
            config = {'cwd': str(root), 'state_dir': str(shared),
                      'start': ['python3', 'app.py'],
                      'health_url': 'http://127.0.0.1:8000/health'}
            state_path = shared / 'service.json'
            state_path.write_text(json.dumps({'pid': 17, 'config': config}))
            original = RuntimeError('replacement startup failed')
            rollback = RuntimeError('previous startup failed')
            with patch.object(service, 'stop'), \
                 patch.object(service, 'launch', side_effect=[original, rollback]):
                with self.assertRaises(RuntimeError) as raised:
                    service.execute('restart', config)
            self.assertIs(raised.exception, original)
            self.assertFalse(state_path.exists())


@unittest.skipUnless(sys.platform == 'linux', 'Process ownership uses the Linux guest /proc')
class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.children = []
        self.addCleanup(lambda: [child.wait(timeout=5) for child in self.children])
        original = subprocess.Popen

        def record_child(*args, **kwargs):
            child = original(*args, **kwargs)
            self.children.append(child)
            return child

        recorder = patch.object(service.subprocess, 'Popen', side_effect=record_child)
        recorder.start()
        self.addCleanup(recorder.stop)
        self.root = Path(self.temporary.name)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        self.server = self.root / 'server.py'
        self.server.write_text(
            'import http.server, os, sys\n'
            'class Handler(http.server.BaseHTTPRequestHandler):\n'
            ' def do_GET(self):\n'
            '  self.send_response(200); self.end_headers(); self.wfile.write(os.environ.get("MARKER", "v1").encode())\n'
            ' def log_message(self, *args): pass\n'
            'http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()\n')
        self.config = {'cwd': str(self.root), 'state_dir': str(self.root / 'shared'),
                       'start': [sys.executable, str(self.server), str(port)],
                       'health_url': f'http://127.0.0.1:{port}/health', 'health_timeout': 3}
        self.addCleanup(self.cleanup_service)

    def state(self):
        return json.loads((self.root / 'shared/service.json').read_text())

    def cleanup_service(self):
        if (self.root / 'shared/service.json').exists():
            try:
                service.stop(self.state())
            except ValueError:
                pass  # Ownership-refusal tests deliberately leave unrelated PID state.

    def probe(self):
        with urllib.request.urlopen(self.config['health_url'], timeout=2) as response:
            return response.read().decode()

    def test_repeat_restart_loads_private_environment_without_executing_it(self):
        service.execute('restart', self.config)
        first = self.state()['pid']
        env = self.root / 'shared/env.json'
        env.write_text(json.dumps({'MARKER': 'v2; literal $(command)'}))
        env.chmod(0o600)
        service.execute('restart', self.config)
        self.assertNotEqual(first, self.state()['pid'])
        self.assertEqual(self.probe(), 'v2; literal $(command)')

    def test_failed_start_restores_previous_service(self):
        service.execute('restart', self.config)
        broken = dict(self.config, start=[sys.executable, '-c', 'raise SystemExit(7)'])
        with self.assertRaises(RuntimeError):
            service.execute('restart', broken)
        self.assertEqual(self.probe(), 'v1')
        self.assertEqual(self.state()['config']['start'], self.config['start'])

    def test_stale_pid_cannot_signal_an_unrelated_process(self):
        process = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True)
        self.addCleanup(process.wait)
        self.addCleanup(lambda: os.killpg(process.pid, signal.SIGKILL) if process.poll() is None else None)
        with self.assertRaisesRegex(ValueError, 'not this managed'):
            service.stop({'pid': process.pid, 'identity': service.identity(process.pid), 'owner': 'wrong-owner'})
        self.assertIsNone(process.poll())

    def test_foreign_service_on_health_port_is_not_claimed_as_ready(self):
        service.execute('restart', self.config)
        with self.assertRaisesRegex(RuntimeError, 'already occupied'):
            service.launch(self.config)
        self.assertEqual(self.probe(), 'v1')

    def test_concurrent_restart_is_rejected_before_current_service_stops(self):
        service.execute('restart', self.config)
        pid = self.state()['pid']
        with (self.root / 'shared/service.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                service.execute('restart', self.config)
        self.assertEqual(self.state()['pid'], pid)
        self.assertEqual(self.probe(), 'v1')

    def test_failed_build_reports_failure_without_stopping_current_service(self):
        service.execute('restart', self.config)
        pid = self.state()['pid']
        with self.assertRaises(subprocess.CalledProcessError):
            service.execute('build', dict(self.config, build=[[sys.executable, '-c', 'raise SystemExit(7)']]))
        self.assertEqual((self.root / 'build.exit').read_text(), '1')
        self.assertEqual(self.state()['pid'], pid)
        self.assertEqual(self.probe(), 'v1')

    def test_invalid_timeout_is_rejected_before_running_service_stops(self):
        service.execute('restart', self.config)
        pid = self.state()['pid']
        for value in [0, -1, True, '30', 100]:
            with self.subTest(timeout=value):
                with self.assertRaisesRegex(ValueError, 'timeout'):
                    service.execute('restart', dict(self.config, health_timeout=value))
                self.assertEqual(self.state()['pid'], pid)
                self.assertEqual(self.probe(), 'v1')


if __name__ == '__main__':
    unittest.main()
