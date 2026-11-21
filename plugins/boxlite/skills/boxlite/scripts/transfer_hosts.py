"""Hand file-tool data to installed hosts over local pipes; hosts own MCP and authentication."""
from contextlib import suppress
import json
import os
from pathlib import Path
import select
import signal
import subprocess
import time

TIMEOUT = 180


class TransferError(Exception):
    pass


def tool_result(value):
    if not isinstance(value, dict) or value.get('isError'):
        raise TransferError('MCP tool failed; completion is unknown')
    return value


class HostProcess:
    """Own one child process group and deadline-limited JSON-lines I/O."""
    def __init__(self, command, cwd):
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, start_new_session=True, cwd=cwd)
        self.buffer = bytearray()
        os.set_blocking(self.process.stdin.fileno(), False)
        self.deadline = time.monotonic() + TIMEOUT

    def close(self):
        try:
            try:
                # Some hosts return EPERM for an exited process that has not been reaped.
                with suppress(ProcessLookupError, PermissionError):
                    os.killpg(self.process.pid, signal.SIGTERM)
                with suppress(subprocess.TimeoutExpired):
                    self.process.wait(timeout=5)
            finally:
                # Leader exit does not imply descendant exit.
                try:
                    with suppress(ProcessLookupError, PermissionError):
                        os.killpg(self.process.pid, signal.SIGKILL)
                finally:
                    self.process.wait(timeout=5)
        finally:
            try:
                self.process.stdin.close()
            finally:
                self.process.stdout.close()

    def remaining(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TransferError('Host timed out; completion is unknown')
        return remaining

    def send(self, value):
        data = memoryview((json.dumps(value) + '\n').encode())
        while data:
            if not select.select([], [self.process.stdin], [], self.remaining())[1]:
                raise TransferError('Host timed out accepting arguments; completion is unknown')
            try:
                size = os.write(self.process.stdin.fileno(), data[:65536])
            except BlockingIOError:
                continue
            except BrokenPipeError:
                raise TransferError('Host stopped accepting arguments') from None
            data = data[size:]

    def receive(self):
        self.remaining()
        newline = self.buffer.find(b'\n')
        while newline < 0:
            if not select.select([self.process.stdout], [], [], self.remaining())[0]:
                raise TransferError('Host timed out returning a result; completion is unknown')
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise TransferError('Host stopped before returning the tool result')
            start = len(self.buffer)
            self.buffer.extend(chunk)
            newline = self.buffer.find(b'\n', start)
        line = self.buffer[:newline]
        del self.buffer[:newline + 1]
        try:
            value = json.loads(line)
        except ValueError:
            raise TransferError('Host returned malformed JSON') from None
        if not isinstance(value, dict):
            raise TransferError('Host returned an invalid message')
        return value


class CodexHost:
    def __init__(self, server, cwd=None):
        if not server:
            raise TransferError('Select an existing Codex MCP connection explicitly')
        self.server = server
        self.cwd = str(Path(cwd or Path.cwd()).absolute())
        self.channel = None
        self.sequence = 0

    def __enter__(self):
        try:
            self.channel = HostProcess(['codex', 'app-server', '--stdio'], self.cwd)
            self.request('initialize', {'clientInfo': {'name': 'boxlite-file-transfer', 'version': '0.2.0'},
                                        'capabilities': {'experimentalApi': True}})
            self.channel.send({'method': 'initialized'})
            result = self.request('thread/start', {'cwd': self.cwd, 'ephemeral': True,
                                                  'approvalPolicy': 'on-request', 'sandbox': 'read-only'})
            self.thread = result['thread']['id']
            return self
        except BaseException:
            self.__exit__()
            raise

    def __exit__(self, *error):
        if self.channel:
            self.channel.close()

    def request(self, method, params):
        self.sequence += 1
        self.channel.deadline = time.monotonic() + TIMEOUT
        self.channel.send({'id': self.sequence, 'method': method, 'params': params})
        while True:
            value = self.channel.receive()
            if 'method' in value and 'id' in value:
                self.channel.send({'id': value['id'], 'error': {'code': -32601,
                                   'message': 'Complete interactive approval in the host'}})
                raise TransferError('Codex requested interaction; complete it in the host before trying again')
            if value.get('id') != self.sequence:
                continue
            if 'error' in value or 'result' not in value:
                raise TransferError(f'Codex request {method} failed; check the selected connection and host version')
            return value['result']

    def call(self, name, arguments):
        return tool_result(self.request('mcpServer/tool/call', {'threadId': self.thread, 'server': self.server,
                                                             'tool': name, 'arguments': arguments}))
