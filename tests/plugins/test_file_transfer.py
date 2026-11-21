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
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).resolve().parents[2] / 'plugins/boxlite/skills/boxlite/scripts'
sys.path.insert(0, str(SCRIPTS))
import archive_worker
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

    def client(self):
        return transfer_hosts.CodexHost('chosen-server', self.root)

    def calls(self):
        path = self.root / 'calls.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def fault(self, name):
        (self.root / 'fault').write_text(name)

    def test_standalone_claude_cli_cannot_upload_outside_calling_session(self):
        result = subprocess.run(
            [sys.executable, str(SCRIPTS / 'transfer.py'), '--host', 'claude',
             '--server', 'chosen-server', 'upload', '--box', 'box-1',
             '--source', str(self.source), '--destination', '/workspace/report'],
            cwd=self.root, capture_output=True, text=True, timeout=20,
        )
        self.assertFalse((self.root / 'claude-launch.json').exists())
        self.assertNotEqual(result.returncode, 0)

    def test_codex_delivers_original_bytes_through_existing_tools(self):
        (self.source / '.env').write_bytes(b'synthetic fixture')
        (self.source / 'alias').symlink_to('.env')
        with self.client() as client:
            result = transfer.upload(client, 'box-1', self.source, '/workspace/fresh')
            self.assertEqual(result['status'], 'completed')
            self.assertEqual(transfer_archive.Archive.decode((self.root / 'uploaded.tar').read_bytes()).tree(),
                             transfer_archive.Archive.snapshot(self.source).tree())
            transfer.download(client, 'box-1', '/workspace/fresh/.', self.destination)
        self.assertEqual(transfer_archive.Archive.snapshot(self.destination).tree(), transfer_archive.Archive.snapshot(self.source).tree())
        self.assertEqual([c['tool'] for c in self.calls()], ['uploadFiles', 'downloadFiles'])
        self.assertEqual(self.calls()[-1]['arguments'], {'box_id': 'box-1', 'path': '/workspace/fresh/.'})

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
                transfer_hosts.tool_result('uploadFiles', value)
        self.fault('empty-ack')
        with self.client() as client, self.assertRaises(transfer_hosts.TransferError):
            transfer.upload(client, 'box-1', self.source, '/workspace/fresh')
        self.assertEqual(len(self.calls()), 1)

    def test_codex_protocol_failure_or_interaction_never_falls_back(self):
        for fault in ('eof', 'json', 'error', 'interaction'):
            self.fault(fault)
            with self.client() as client, self.assertRaises(transfer_hosts.TransferError):
                transfer.upload(client, 'box-1', self.source, '/workspace/fresh')
            self.assertIsNotNone(client.channel.process.poll())
        self.assertFalse(self.calls())

    def test_codex_distinguishes_upload_refusal_from_unknown_completion(self):
        client = self.client()
        client.thread = 'fixture-thread'
        for reply, expected in (
            ({'content': [{'type': 'text', 'text': 'HTTP 403'}]}, 'Server refused the upload'),
            ({'structuredContent': {'statusCode': 403, 'message': 'private detail'}}, 'Server refused the upload'),
            ({'content': [{'type': 'text', 'text': 'upstream mentioned HTTP 403: private detail'}]}, 'completion is unknown'),
        ):
            with self.subTest(reply=reply), patch.object(client, 'request', return_value={'isError': True, **reply}):
                with self.assertRaisesRegex(transfer_hosts.TransferError, expected) as error:
                    transfer.upload(client, 'box-1', self.source, '/workspace/fresh')
                self.assertNotIn('private detail', str(error.exception))

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

    def test_host_timeout_cleans_up_child(self):
        with patch.object(transfer_hosts, 'TIMEOUT', 0), self.assertRaises(transfer_hosts.TransferError):
            with self.client():
                self.fail('Timeout must not connect')
        self.assertFalse(self.calls())

    def test_cli_rejects_relative_paths_before_starting_codex(self):
        for operation in ('upload', 'download'):
            for option in ('--source', '--destination'):
                paths = {'--source': '/workspace/source', '--destination': str(self.destination)}
                paths[option] = 'relative/path'
                argv = ['transfer.py', '--host', 'codex', '--server', 'chosen-server', operation,
                        '--box', 'box-1', '--source', paths['--source'], '--destination', paths['--destination']]
                with self.subTest(operation=operation, option=option), patch.object(sys, 'argv', argv), \
                        patch.object(transfer, 'CodexHost') as host, contextlib.redirect_stderr(io.StringIO()) as stderr:
                    with self.assertRaises(SystemExit) as error:
                        transfer.main()
                    self.assertEqual(error.exception.code, 2)
                    self.assertIn(option, stderr.getvalue())
                    self.assertIn('absolute path', stderr.getvalue())
                    host.assert_not_called()

    def test_cli_prints_only_receipts_and_rejects_credential_options(self):
        command = [sys.executable, str(SCRIPTS / 'transfer.py'), '--host', 'codex', '--server', 'chosen-server']
        for operation, source, destination in [('upload', self.source, '/workspace/new'),
                                                ('download', '/workspace/new/.', self.destination)]:
            run = subprocess.run(command + [operation, '--box', 'box-1', '--source', str(source),
                                           '--destination', str(destination)], cwd=self.root, capture_output=True,
                                 text=True, timeout=15)
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
            with self.client() as client:
                transfer.upload(client, 'box-1', self.source, '/workspace/fresh')

    def test_saved_download_refuses_other_sessions_and_ambiguous_results(self):
        project = self.root / 'project'
        directory = project / 'session/tool-results'
        directory.mkdir(parents=True)
        started = time.time_ns() // 1_000_000
        saved = directory / f'mcp-chosen-server-downloadFiles-{started}-first.txt'
        saved.write_text('{}')
        receipt = {'transcriptPath': str(project / 'session.jsonl'), 'connection': 'chosen-server',
                   'started': started, 'finished': started, 'path': str(saved), 'size': saved.stat().st_size}
        encoded = transfer.pack_source(self.source)
        saved.write_text(json.dumps({'base64': encoded}))
        transfer.save_archive(archive_worker.saved_archive(receipt), self.destination)
        self.assertEqual((self.destination / 'binary.bin').read_bytes(), (self.source / 'binary.bin').read_bytes())

        backing = self.root / 'result.txt'
        saved.rename(backing)
        saved.symlink_to(backing)
        storage = self.root / 'storage'
        project.rename(storage)
        project.symlink_to(storage)
        self.assertEqual(archive_worker.saved_archive(dict(receipt, path=str(backing))), encoded)
        with self.assertRaises(transfer.TransferError):
            archive_worker.saved_archive(dict(receipt, path=str(self.source / 'binary.bin')))
        with self.assertRaises(transfer.TransferError):
            archive_worker.saved_archive(dict(receipt, transcriptPath=str(project / 'other.jsonl')))
        (directory / f'mcp-chosen-server-downloadFiles-{started}-second.txt').touch()
        with self.assertRaises(transfer.TransferError):
            archive_worker.saved_archive(receipt)

    def test_download_checks_metadata_and_base64_before_writing(self):
        cases = [{}, {'content': []}, {'content': [{'type': 'text', 'text': 'invalid JSON'}]},
                 {'content': None}, {'content': [None]}, {'content': [{'type': 'text', 'text': None}]},
                 {'structuredContent': {'base64': '!'}}, {'structuredContent': {'base64': 1}}]
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

    def test_authorized_worker_transfers_selected_names_and_links(self):
        selected = self.source / '.env'
        selected.write_bytes(b'selected contents')
        (self.source / 'alias').symlink_to('.env')
        worker = [sys.executable, str(SCRIPTS / 'archive_worker.py')]
        packed = subprocess.run(worker + ['pack', str(self.source)], capture_output=True)
        self.assertEqual(packed.returncode, 0, packed.stderr)
        saved = subprocess.run(worker + ['save', str(self.destination)], input=packed.stdout, capture_output=True)
        self.assertEqual(saved.returncode, 0, saved.stderr)
        self.assertEqual((self.destination / '.env').read_bytes(), selected.read_bytes())
        self.assertEqual(os.readlink(self.destination / 'alias'), '.env')

    def test_upload_limit_counts_pax_headers_and_final_record_padding(self):
        directory = self.root / 'boundary'
        directory.mkdir()
        source = directory / ('x' * 110)
        largest_record = (8 << 20) // tarfile.RECORDSIZE * tarfile.RECORDSIZE
        # Directory header, PAX header and data, file header, and two end blocks.
        with source.open('wb') as stream:
            stream.truncate(largest_record - 6 * tarfile.BLOCKSIZE)
        self.assertEqual(len(base64.b64decode(transfer.pack_source(directory))), largest_record)
        with source.open('ab') as stream:
            stream.write(b'x')
        with self.client() as client, patch.object(os, 'fdopen', wraps=os.fdopen) as open_stream:
            with self.assertRaisesRegex(ValueError, '8 MiB'):
                transfer.upload(client, 'box-1', directory, '/workspace/data')
            open_stream.assert_not_called()
        self.assertFalse(self.calls())

    def test_download_gnu_sparse_files_preserves_extents_and_logical_size(self):
        def sparse_entry(name, size, offset, data, extent_size=None):
            # Old GNU sparse header layout emitted by the guest's tar-rs packer.
            info = tarfile.TarInfo(name)
            info.type = tarfile.GNUTYPE_SPARSE
            info.mode = 0o755
            info.size = len(data)
            header = bytearray(info.tobuf(tarfile.GNU_FORMAT))
            if extent_size is None:
                extent_size = len(data)
            for start, value in ((386, offset), (398, extent_size), (483, size)):
                header[start:start + 12] = b'%011o\0' % value
            header[148:156] = b' ' * 8
            header[148:156] = b'%06o\0 ' % sum(header)
            return header + data + b'\0' * (-len(data) % tarfile.BLOCKSIZE)

        size = 16 << 20
        raw = (sparse_entry('empty.img', 1 << 20, 1 << 20, b'')
               + sparse_entry('disk.img', size, size // 2, b'payload') + bytes(1024))
        (self.root / 'uploaded.tar').write_bytes(raw)
        with self.client() as client:
            transfer.download(client, 'box-1', '/workspace/data', self.destination)
        self.assertEqual((self.destination / 'empty.img').stat().st_size, 1 << 20)
        path = self.destination / 'disk.img'
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700)
        self.assertEqual(path.stat().st_size, size)
        with path.open('rb') as stream:
            stream.seek(size // 2 - 1)
            self.assertEqual(stream.read(9), b'\0payload\0')
        # A claimed extent must fit both the stored data and the logical file.
        for offset, extent_size in ((0, 8), (size - 1, 7)):
            raw = sparse_entry('invalid', size, offset, b'payload', extent_size) + bytes(1024)
            with self.subTest(offset=offset), self.assertRaisesRegex(ValueError, 'sparse extent'):
                transfer.save_archive(base64.b64encode(raw), self.root / 'invalid-download')
            self.assertFalse((self.root / 'invalid-download').exists())

    def test_existing_download_destination_is_refused_before_call(self):
        with self.client() as client, self.assertRaises(transfer_hosts.TransferError):
            transfer.download(client, 'box-1', '/workspace/data/.', self.source)
        self.assertFalse(self.calls())

    def test_untrusted_archive_paths_and_special_files_are_rejected(self):
        for name, kind in [('../outside', tarfile.REGTYPE), ('/outside', tarfile.REGTYPE),
                           ('fifo', tarfile.FIFOTYPE)]:
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

    def test_host_reads_multiple_frames_from_one_write(self):
        script = 'import os; os.write(1, b\'{"text":"abc"}\\n{"id":2}\\n\')'
        child = transfer_hosts.HostProcess([sys.executable, '-c', script], self.root)
        try:
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

    def test_file_transfer_preserves_single_file_landing_and_owner_permissions(self):
        single = self.source / 'start.sh'
        single.write_bytes(b'fixture')
        single.chmod(0o500)
        with self.client() as client:
            transfer.upload(client, 'box-1', single, '/workspace/start.sh')
            transfer.download(client, 'box-1', '/workspace/start.sh', self.destination)
        with tarfile.open(self.root / 'uploaded.tar') as archive:
            self.assertEqual([(member.name, member.mode) for member in archive], [('start.sh', 0o500)])
        downloaded = self.destination / 'start.sh'
        self.assertEqual(stat.S_IMODE(downloaded.stat().st_mode), 0o500)
        self.assertEqual(downloaded.read_bytes(), b'fixture')
        single.chmod(0o755)
        with tarfile.open(fileobj=io.BytesIO(transfer_archive.Archive.snapshot(self.source).encode())) as archive:
            self.assertTrue(archive.next().isdir())
            self.assertEqual(archive.getmember('start.sh').mode, 0o700)
            self.assertEqual(archive.getmember('binary.bin').mode, 0o600)

    def test_explicit_directory_permissions_on_upload_and_download(self):
        assets = self.source / 'assets'
        assets.mkdir()
        (assets / 'logo').write_bytes(b'logo')
        assets.chmod(0o555)
        self.source.chmod(0o555)
        with self.client() as client:
            transfer.upload(client, 'box-1', self.source, '/workspace/site')
        with tarfile.open(self.root / 'uploaded.tar') as archive:
            with self.subTest(direction='upload'):
                self.assertEqual([archive.getmember(p).mode for p in ('.', 'assets')], [0o500, 0o500])

        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode='w') as archive:
            for name in ('.', 'assets'):
                directory = tarfile.TarInfo(name)
                directory.type, directory.mode = tarfile.DIRTYPE, 0o555
                archive.addfile(directory)
            logo = tarfile.TarInfo('assets/images/logo')
            logo.size = 4
            archive.addfile(logo, io.BytesIO(b'logo'))
        (self.root / 'uploaded.tar').write_bytes(raw.getvalue())
        with self.client() as client:
            transfer.download(client, 'box-1', '/workspace/site/.', self.destination)
        self.assertEqual((self.destination / 'assets/images/logo').read_bytes(), b'logo')
        for path, mode in (('.', 0o500), ('assets', 0o500), ('assets/images', 0o700)):
            with self.subTest(download=path):
                self.assertEqual(stat.S_IMODE((self.destination / path).stat().st_mode), mode)

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
        link = ('alias', transfer_archive.SymbolicLink('target'))
        child = ('alias/file', b'fixture')
        for first, second in [(link, child), (child, link)]:
            archive = transfer_archive.Archive()
            archive.add(*first)
            with self.assertRaisesRegex(ValueError, 'conflict'):
                archive.add(*second)
        with self.assertRaises(ValueError):
            transfer_archive.Archive.decode(b'truncated')


if __name__ == '__main__':
    unittest.main()
