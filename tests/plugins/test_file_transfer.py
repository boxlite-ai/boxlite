"""File contracts and host-control boundaries; native hosts are tested separately."""
import base64
import contextlib
import errno
import io
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'plugins/boxlite/skills/boxlite/scripts'
sys.path.insert(0, str(SCRIPTS))
import transfer
import transfer_hosts
import transfer_archive


class FileTransferTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / 'source'
        self.source.mkdir()
        (self.source / 'binary.bin').write_bytes(bytes(range(256)) * 1024)
        (self.source / 'nested').mkdir()
        (self.source / 'nested' / '中文 name.txt').write_text('hello\n世界\n')
        (self.source / 'empty').mkdir()
        self.destination = self.root / 'download'
        for name in ('codex', 'claude'):
            executable = self.root / name
            shutil.copyfile(Path(__file__).parent / 'fixtures/transfer_host.py', executable)
            executable.chmod(0o700)
        environment = patch.dict(os.environ, {'PATH': str(self.root) + os.pathsep + os.environ['PATH']})
        environment.start()
        self.addCleanup(environment.stop)

    def client(self, host):
        return (transfer_hosts.CodexHost if host == 'codex' else transfer_hosts.ClaudeHost)('chosen-server', self.root)

    def calls(self):
        path = self.root / 'calls.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def fault(self, name):
        (self.root / 'fault').write_text(name)

    def test_both_hosts_deliver_original_bytes_through_existing_tools(self):
        for host in ('codex', 'claude'):
            with self.subTest(host=host), self.client(host) as client:
                result = transfer.upload(client, 'box-1', self.source, '/workspace/fresh')
                self.assertEqual(result['status'], 'completed')
                self.assertEqual(transfer_archive.Archive.decode((self.root / 'uploaded.tar').read_bytes()).tree(),
                                 transfer_archive.Archive.snapshot(self.source).tree())
                transfer.download(client, 'box-1', '/workspace/fresh/.', self.root / (host + '-out'))
            self.assertEqual(transfer_archive.Archive.snapshot(self.root / (host + '-out')).tree(), transfer_archive.Archive.snapshot(self.source).tree())
        self.assertEqual([c['tool'] for c in self.calls()], ['uploadFiles', 'downloadFiles'] * 2)
        self.assertEqual(self.calls()[-1]['arguments'], {'box_id': 'box-1', 'path': '/workspace/fresh/.'})

    def test_claude_model_receives_only_placeholder_and_control_channel_receives_data(self):
        with self.client('claude') as client:
            transfer.upload(client, 'box-1', self.source, '/workspace/fresh')
        prompt = json.loads((self.root / 'model-input.json').read_text())
        self.assertEqual(prompt['arguments']['body_base64'], transfer_hosts.PLACEHOLDER)
        self.assertLess(len(json.dumps(prompt)), 300)
        self.assertGreater(len(self.calls()[0]['arguments']['body_base64']), 256000)

    def test_empty_unexpected_or_error_acknowledgments_never_report_success(self):
        invalid = [{}, {'content': []}, {'content': [{'type': 'text', 'text': ''}]},
                   {'content': [{'type': 'text', 'text': 'HTTP 202'}]}]
        class Response:
            def __init__(self, value):
                self.value = value
            def call(self, *args):
                return self.value
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(transfer_hosts.TransferError):
                transfer.upload(Response(value), 'box-1', self.source, '/workspace/fresh')
        for value in (None, [], {'isError': True}):
            with self.assertRaises(transfer_hosts.TransferError):
                transfer_hosts.tool_result(value)
        for host in ('codex', 'claude'):
            self.fault('empty-ack')
            with self.client(host) as client, self.assertRaises(transfer_hosts.TransferError):
                transfer.upload(client, 'box-1', self.source, '/workspace/fresh')
        self.assertEqual(len(self.calls()), 2)

    def test_claude_rejects_wrong_operation_and_never_uses_a_model_success_claim(self):
        for fault in ('wrong-target', 'wrong-tool', 'wrong-server', 'no-callback'):
            self.fault(fault)
            with self.subTest(fault=fault), self.client('claude') as client, self.assertRaises(transfer_hosts.TransferError):
                transfer.upload(client, 'box-1', self.source, '/workspace/fresh')
        self.assertFalse(self.calls())

    def test_claude_does_not_approve_twice_or_ignore_tool_errors(self):
        for fault in ('repeat', 'tool-error', 'raw-tool-error'):
            self.fault(fault)
            before = len(self.calls())
            with self.client('claude') as client, self.assertRaises(transfer_hosts.TransferError):
                transfer.upload(client, 'box-1', self.source, '/workspace/fresh')
            self.assertEqual(len(self.calls()), before + 1)

    def test_claude_requires_the_guard_before_dispatch(self):
        (self.root / 'uploaded.tar').write_bytes(transfer_archive.Archive.snapshot(self.source).encode())
        for fault in ('managed-wrong-target', 'hooks-ignored', 'hook-failure-unsupported'):
            self.fault(fault)
            with self.subTest(fault=fault):
                prior_calls = self.calls()
                with self.client('claude') as client, self.assertRaises(transfer_hosts.TransferError):
                    transfer.download(client, 'box-1', '/workspace/fresh', self.destination)
                self.assertEqual(self.calls(), prior_calls)
                self.assertFalse(self.destination.exists())

    def test_claude_preserves_host_permission_decisions(self):
        for fault in ('managed-deny', 'managed-ask'):
            with self.subTest(fault=fault):
                self.fault(fault)
                with self.client('claude') as client, self.assertRaises(transfer_hosts.TransferError):
                    transfer.upload(client, 'box-1', self.source, '/workspace/fresh')
                self.assertFalse(self.calls())

    def test_claude_ignores_project_settings_and_requires_explicit_project_connection(self):
        project = self.root / 'project'
        project.mkdir()
        config = project / '.mcp.json'
        config.write_text('{}')
        launch = self.root / 'claude-launch.json'
        with transfer_hosts.ClaudeHost('chosen-server', cwd=project) as client:
            with self.assertRaisesRegex(transfer_hosts.TransferError, 'trusted'):
                transfer.upload(client, 'box-1', self.source, '/workspace/fresh')
        self.assertFalse(launch.exists())

        with transfer_hosts.ClaudeHost('chosen-server', cwd=project, mcp_config=config) as client:
            transfer.upload(client, 'box-1', self.source, '/workspace/fresh')
        observed = json.loads(launch.read_text())
        self.assertNotEqual(Path(observed['cwd']).resolve(), project)
        self.assertEqual(observed['args'][observed['args'].index('--setting-sources') + 1], 'user')
        self.assertEqual(observed['args'][observed['args'].index('--mcp-config') + 1], str(config))

    def test_claude_never_uses_truncated_display_content_as_download_bytes(self):
        (self.root / 'uploaded.tar').write_bytes(transfer_archive.Archive.snapshot(self.source).encode())
        self.fault('missing-structured')
        with self.client('claude') as client, self.assertRaises(transfer_hosts.TransferError):
            transfer.download(client, 'box-1', '/workspace/fresh/.', self.destination)
        self.assertFalse(self.destination.exists())

    def test_claude_reads_large_result_only_from_its_current_session_without_symlinks(self):
        (self.root / 'uploaded.tar').write_bytes(transfer_archive.Archive.snapshot(self.source).encode())
        with patch.dict(os.environ, {'CLAUDE_CONFIG_DIR': str(self.root / 'claude-results')}):
            self.fault('persisted')
            with self.client('claude') as client:
                transfer.download(client, 'box-1', '/workspace/fresh/.', self.destination)
            self.assertEqual(transfer_archive.Archive.snapshot(self.destination).tree(), transfer_archive.Archive.snapshot(self.source).tree())
            self.fault('persisted-link')
            with self.client('claude') as client, self.assertRaises(OSError):
                transfer.download(client, 'box-1', '/workspace/fresh/.', self.root / 'refused')
            self.assertFalse((self.root / 'refused').exists())

    def test_claude_result_file_notice_cannot_select_unrelated_files_or_sessions(self):
        client = self.client('claude')
        config = self.root / 'private-claude'
        with patch.dict(os.environ, {'CLAUDE_CONFIG_DIR': str(config)}):
            for target in (self.root / 'credentials.json',
                           config / 'projects/project/other-session/tool-results/mcp-data.txt',
                           config / 'projects/project/current/tool-results/credentials.json',
                           config / 'projects/project/current/tool-results/../mcp-data.txt'):
                notice = ('Error: result (1,000,000 characters) exceeds maximum allowed tokens. '
                          + 'Output has been saved to ' + str(target) + '.\nFormat: JSON')
                with self.assertRaises(transfer_hosts.TransferError):
                    client.download_result({'structuredContentOmitted': True}, notice, 'current')
            for raw, content in [({'structuredContentOmitted': True}, 'model-selected path'),
                                 ({'isError': True, 'structuredContent': {'base64': ''}}, ''),
                                 ({}, 'display truncated')]:
                with self.assertRaises(transfer_hosts.TransferError):
                    client.download_result(raw, content, 'current')

    def test_codex_protocol_failure_or_interaction_never_falls_back(self):
        for fault in ('eof', 'json', 'error', 'interaction'):
            self.fault(fault)
            with self.client('codex') as client, self.assertRaises(transfer_hosts.TransferError):
                transfer.upload(client, 'box-1', self.source, '/workspace/fresh')
            self.assertIsNotNone(client.channel.process.poll())
        self.assertFalse(self.calls())

    def test_cleanup_kills_descendant_when_host_exits_first(self):
        endpoint = self.root / 'child.sock'
        child = ("import signal,socket,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); "
                 "s=socket.socket(socket.AF_UNIX); s.connect(" + repr(str(endpoint)) + "); "
                 "s.sendall(b'ready'); time.sleep(30)")
        parent = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c'," + repr(child) + "]); time.sleep(30)"
        with socket.socket(socket.AF_UNIX) as listener:
            listener.bind(str(endpoint))
            listener.listen(1)
            listener.settimeout(5)
            host = transfer_hosts.HostProcess([sys.executable, '-c', parent], self.root)
            try:
                connection, _ = listener.accept()
                with connection:
                    connection.settimeout(2)
                    self.assertEqual(connection.recv(5), b'ready')
                    host.close()
                    self.assertIsNotNone(host.process.poll())
                    try:
                        self.assertEqual(connection.recv(1), b'')
                    except socket.timeout:
                        self.fail('A descendant retained its socket after the host exited and cleanup completed')
            finally:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(host.process.pid, signal.SIGKILL)
                host.process.wait(timeout=5)
                host.process.stdin.close()
                host.process.stdout.close()

    def test_host_timeout_and_message_limit_cleanup_children(self):
        with patch.object(transfer_hosts, 'TIMEOUT', 0), self.assertRaises(transfer_hosts.TransferError):
            with self.client('codex'):
                self.fail('Timeout must not connect')
        with self.client('codex') as client, patch.object(transfer_hosts, 'MAX_MESSAGE', 1024):
            with self.assertRaises(transfer_hosts.TransferError):
                transfer.upload(client, 'box-1', self.source, '/workspace/fresh')
        self.assertIsNotNone(client.channel.process.poll())
        self.assertFalse(self.calls())

    def test_cli_prints_only_receipts_and_rejects_credential_options(self):
        for host in ('codex', 'claude'):
            command = [sys.executable, str(SCRIPTS / 'transfer.py'), '--host', host, '--server', 'chosen-server']
            for operation, source, destination in [('upload', self.source, '/workspace/new'),
                                                    ('download', '/workspace/new/.', self.root / (host + '-download'))]:
                run = subprocess.run(command + [operation, '--box', 'box-1', '--source', str(source),
                                               '--destination', str(destination)], capture_output=True, text=True, timeout=15)
                self.assertEqual(run.returncode, 0, run.stderr)
                self.assertEqual(json.loads(run.stdout)['status'], 'completed')
                self.assertLess(len(run.stdout), 300)
                self.assertNotIn('base64', run.stdout)
        run = subprocess.run(command + ['--token-env', 'BOXLITE_API_KEY'], capture_output=True, text=True)
        self.assertNotEqual(run.returncode, 0)

    def test_helper_does_not_read_credential_environment_or_configuration(self):
        assert_no_credentials = self.assertFalse
        class Environment(dict):
            def __getitem__(self, key):
                # KeyError would be swallowed by get(), hiding a credential read.
                assert_no_credentials(any(part in key.upper() for part in ('TOKEN', 'SECRET', 'API_KEY')),
                                      'Helper accessed credential environment')
                return super().__getitem__(key)
            def get(self, key, default=None):
                try:
                    return self[key]
                except KeyError:
                    return default
        with patch.object(os, 'environ', Environment(os.environ)):
            for host in ('codex', 'claude'):
                with self.client(host) as client:
                    transfer.upload(client, 'box-1', self.source, '/workspace/fresh')
        config = self.root / 'not-readable.json'
        config.write_text('private host configuration')
        config.chmod(0)
        client = transfer_hosts.ClaudeHost('chosen-server', mcp_config=config, plugin_dir=self.root)
        self.assertEqual(client.options, ['--mcp-config', str(config), '--strict-mcp-config', '--plugin-dir', str(self.root)])

    def test_claude_model_login_error_is_distinct_from_boxlite_authorization(self):
        self.fault('not-logged-in')
        with self.client('claude') as client, self.assertRaisesRegex(transfer_hosts.TransferError, 'Claude model session is not signed in'):
            transfer.upload(client, 'box-1', self.source, '/workspace/fresh')
        self.assertFalse(self.calls())

    def test_main_selects_both_hosts_without_credentials(self):
        for host in ('codex', 'claude'):
            args = ['transfer.py', '--host', host, '--server', 'chosen-server', 'upload', '--box', 'box-1',
                    '--source', str(self.source), '--destination', '/workspace/new']
            output = io.StringIO()
            with patch.object(sys, 'argv', args), contextlib.redirect_stdout(output):
                self.assertEqual(transfer.main(), 0)
            self.assertEqual(json.loads(output.getvalue())['status'], 'completed')
        self.assertEqual(len(self.calls()), 2)

    def test_main_refuses_wrong_host_configuration(self):
        args = ['transfer.py', '--host', 'codex', '--server', 'chosen-server', '--mcp-config', '/private',
                'upload', '--box', 'box-1', '--source', str(self.source), '--destination', '/workspace/new']
        with patch.object(sys, 'argv', args), contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(transfer.main(), 1)
        self.assertFalse(self.calls())
        for host in (transfer_hosts.CodexHost, transfer_hosts.ClaudeHost):
            with self.assertRaises(transfer_hosts.TransferError):
                host('')

    def test_download_checks_metadata_base64_and_size_before_writing(self):
        cases = [{}, {'content': []}, {'content': [{'type': 'text', 'text': 'invalid JSON'}]},
                 {'content': None}, {'content': [None]}, {'content': [{'type': 'text', 'text': None}]},
                 {'structuredContent': {'base64': '!'}}, {'structuredContent': {'base64': 1}},
                 {'structuredContent': {'base64': 'A' * (4 * ((transfer.MAX_BYTES + 2) // 3) + 1)}}]
        class Response:
            def __init__(self, value):
                self.value = value
            def call(self, *args):
                return self.value
        for value in cases:
            with self.assertRaises(transfer_hosts.TransferError):
                transfer.download(Response(value), 'box-1', '/workspace/fresh/.', self.destination)
            self.assertFalse(self.destination.exists())
        encoded = base64.b64encode(transfer_archive.Archive.snapshot(self.source).encode()).decode()
        value = {'content': [{'type': 'text', 'text': json.dumps({'base64': encoded})}]}
        transfer.download(Response(value), 'box-1', '/workspace/fresh/.', self.destination)
        self.assertEqual(transfer_archive.Archive.snapshot(self.destination).tree(), transfer_archive.Archive.snapshot(self.source).tree())

    def test_source_symlinks_and_existing_destinations_are_refused_before_calls(self):
        link = self.root / 'alias'
        link.symlink_to(self.source, target_is_directory=True)
        with self.client('codex') as client:
            with self.assertRaises(OSError):
                transfer.upload(client, 'box-1', link, '/workspace/new')
            with self.assertRaises(transfer_hosts.TransferError):
                transfer.download(client, 'box-1', '/workspace/data/.', self.source)
        self.assertFalse(self.calls())

    def test_untrusted_archive_paths_and_links_are_rejected(self):
        for name, kind in [('../outside', tarfile.REGTYPE), ('/outside', tarfile.REGTYPE),
                           ('alias', tarfile.SYMTYPE), ('fifo', tarfile.FIFOTYPE)]:
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode='w') as archive:
                member = tarfile.TarInfo(name)
                member.type = kind
                member.linkname = '/outside'
                archive.addfile(member)
            with self.assertRaises(ValueError):
                transfer_archive.Archive.decode(stream.getvalue())
            self.assertFalse(self.destination.exists())

    def test_download_requires_a_complete_tar_end_marker(self):
        archive = transfer_archive.Archive()
        archive.add('first', b'a')
        archive.add('second', b'b')
        encoded = archive.encode()
        with tarfile.open(fileobj=io.BytesIO(encoded), mode='r:') as reader:
            second = reader.getmember('second').offset
            end = reader.offset

        class Response:
            def call(self, *args):
                return {'structuredContent': {'base64': base64.b64encode(raw).decode()}}

        damaged = bytearray(encoded)
        damaged[second] ^= 1
        for label, raw in (('truncated', encoded[:second]), ('short footer', encoded[:end + 512]),
                           ('corrupt header', damaged)):
            destination = self.root / label
            with self.subTest(label=label):
                with self.assertRaises(ValueError):
                    transfer.download(Response(), 'box-1', '/workspace/data', destination)
                self.assertFalse(destination.exists())
        raw = encoded[:end + 1024]
        transfer.download(Response(), 'box-1', '/workspace/data', self.destination)
        self.assertEqual((self.destination / 'second').read_bytes(), b'b')

    def test_download_write_failure_can_retry_at_the_same_path(self):
        archive = transfer_archive.Archive()
        archive.add('first', b'a')
        archive.add('nested/second', b'b')
        open_file = os.open

        def fail_second(path, flags, *args, **kwargs):
            if path == 'second' and flags & os.O_CREAT:
                raise OSError(errno.ENOSPC, 'fixture disk is full')
            return open_file(path, flags, *args, **kwargs)

        before = set(self.root.iterdir())
        with patch.object(os, 'open', fail_second), self.assertRaises(OSError):
            archive.save(self.destination)
        self.assertEqual(set(self.root.iterdir()), before)
        archive.save(self.destination)
        self.assertEqual((self.destination / 'nested/second').read_bytes(), b'b')

    def test_download_never_replaces_a_directory_created_during_write(self):
        archive = transfer_archive.Archive()
        archive.add('one', b'a')
        open_file = os.open

        def create_destination(path, flags, *args, **kwargs):
            if path == 'one' and flags & os.O_CREAT:
                self.destination.mkdir(exist_ok=True)
            return open_file(path, flags, *args, **kwargs)

        before = set(self.root.iterdir())
        with patch.object(os, 'open', create_destination), self.assertRaises(FileExistsError):
            archive.save(self.destination)
        self.assertEqual(list(self.destination.iterdir()), [])
        self.assertEqual(set(self.root.iterdir()), before | {self.destination})

    def test_source_policy_folds_case_without_renaming_allowed_files(self):
        for name in ('.ENV', '.SSH', 'certificate.PEM', 'private.KEY'):
            path = self.source / name
            path.write_bytes(b'fixture')
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, 'Sensitive'):
                transfer_archive.Archive.snapshot(path)
            path.unlink()
        path = self.source / 'ReadMe.TXT'
        path.write_bytes(b'ok')
        self.assertEqual(transfer_archive.Archive.snapshot(path).files, {'ReadMe.TXT': b'ok'})

    def test_upload_explains_ustar_filename_limit_before_contacting_host(self):
        path = self.source / ('x' * 101)
        path.write_bytes(b'fixture')
        with self.client('codex') as client, self.assertRaisesRegex(ValueError, 'USTAR'):
            transfer.upload(client, 'box-1', path, '/workspace/fresh')
        self.assertFalse(self.calls())

    def test_host_message_limit_applies_to_each_complete_frame(self):
        script = 'import os; os.write(1, b\'{"text":"abc"}\\n{"id":2}\\n\')'
        child = transfer_hosts.HostProcess([sys.executable, '-c', script], self.root)
        try:
            with patch.object(transfer_hosts, 'MAX_MESSAGE', 15):
                self.assertEqual(child.receive(), {'text': 'abc'})
                self.assertEqual(child.receive(), {'id': 2})
        finally:
            child.close()

    def test_group_signal_permission_errors_still_close_and_reap_the_child(self):
        for refused in (signal.SIGTERM, signal.SIGKILL):
            with self.subTest(signal=refused):
                host = transfer_hosts.HostProcess([sys.executable, '-c', ''], self.root)
                host.process.wait(timeout=5)

                def signal_group(pid, sig):
                    if sig == refused:
                        raise PermissionError(errno.EPERM, 'fixture signal denied')

                with patch.object(os, 'killpg', signal_group), patch.object(host.process, 'wait', wraps=host.process.wait) as wait:
                    host.close()
                    wait.assert_called()
                self.assertTrue(host.process.stdin.closed)
                self.assertTrue(host.process.stdout.closed)

    def test_upload_archive_preserves_single_file_landing_and_owner_execute(self):
        single = self.source / 'start.sh'
        single.write_bytes(b'fixture')
        single.chmod(0o755)
        with tarfile.open(fileobj=io.BytesIO(transfer_archive.Archive.snapshot(single).encode())) as archive:
            self.assertEqual([(member.name, member.mode) for member in archive], [('start.sh', 0o700)])
        with tarfile.open(fileobj=io.BytesIO(transfer_archive.Archive.snapshot(self.source).encode())) as archive:
            self.assertTrue(archive.next().isdir())
            self.assertEqual(archive.getmember('start.sh').mode, 0o700)
            self.assertEqual(archive.getmember('binary.bin').mode, 0o600)

    def test_upload_discovery_uses_a_bounded_directory_listing(self):
        names_seen = []
        scandir = os.scandir

        @contextlib.contextmanager
        def recording_scan(fd):
            with scandir(fd) as entries:
                def counted():
                    for entry in entries:
                        names_seen.append(entry.name)
                        yield entry
                yield counted()

        with patch.object(transfer_archive, 'MAX_ENTRIES', 1), patch.object(os, 'scandir', recording_scan):
            with self.assertRaisesRegex(ValueError, 'Too many archive entries'):
                transfer_archive.Archive.snapshot(self.source)
        self.assertEqual(len(names_seen), 2)

    def test_download_reports_when_published_files_no_longer_match_requested_path(self):
        parent = self.root / 'parent'
        parent.mkdir()
        moved = self.root / 'moved'
        destination = parent / 'download'
        archive = transfer_archive.Archive()
        archive.add('report', b'fixture')
        publish = transfer_archive._publish_directory

        def move_and_publish(*args):
            parent.rename(moved)
            parent.mkdir()
            publish(*args)

        with patch.object(transfer_archive, '_publish_directory', move_and_publish):
            with self.assertRaisesRegex(ValueError, 'written.*requested path'):
                archive.save(destination)
        self.assertFalse(destination.exists())
        self.assertEqual((moved / 'download/report').read_bytes(), b'fixture')

    def test_archive_boundaries_are_checked_before_filesystem_writes(self):
        for names in [('same', 'same'), ('parent', 'parent/file'), ('parent/file', 'parent')]:
            stream = io.BytesIO()
            with tarfile.open(fileobj=stream, mode='w') as archive:
                for name in names:
                    archive.addfile(tarfile.TarInfo(name))
            with self.assertRaises(ValueError):
                transfer_archive.Archive.decode(stream.getvalue())
        for name in ('bad\\name', '', 'bad\nname'):
            with self.assertRaises(ValueError):
                transfer_archive.Archive().add(name, b'x')
        with self.assertRaises(ValueError):
            transfer_archive.Archive().add('.', b'not a directory')
        with patch.object(transfer_archive, 'MAX_ENTRIES', 2):
            archive = transfer_archive.Archive()
            archive.add('one', b'a')
            archive.add('two', b'b')
            self.assertEqual(transfer_archive.Archive.decode(archive.encode()).tree(), archive.tree())
            with self.assertRaises(ValueError):
                archive.add('three', b'c')
        archive = transfer_archive.Archive()
        archive.add('one/two/three/file', b'x')
        with patch.object(transfer_archive, 'MAX_ENTRIES', 2), self.assertRaises(ValueError):
            archive.save(self.destination)
        self.assertFalse(self.destination.exists())
        with patch.object(transfer_archive, 'MAX_BYTES', 4096), self.assertRaises(ValueError):
            transfer_archive.Archive.snapshot(self.source)
        archive = transfer_archive.Archive()
        archive.add('small', b'x')
        with patch.object(transfer_archive, 'MAX_BYTES', 4096), self.assertRaises(ValueError):
            archive.encode()
        with self.assertRaises(ValueError):
            transfer_archive.Archive.decode(b'truncated')
        (self.source / '.env').write_text('not for transfer')
        with self.assertRaises(ValueError):
            transfer_archive.Archive.snapshot(self.source)


if __name__ == '__main__':
    unittest.main()
