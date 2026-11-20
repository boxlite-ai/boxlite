"""Hand file-tool data to installed hosts over local pipes; hosts own MCP and authentication."""
import json
import os
from pathlib import Path
import re
import select
import signal
import stat
import subprocess
import time
import uuid

from transfer_archive import open_node

TIMEOUT = 180
MAX_MESSAGE = 32 * 1024 * 1024
PLACEHOLDER = '__BOXLITE_FILE_DATA__'
CLAUDE_GUARD = 'boxlite-file-transfer'


class TransferError(Exception):
    pass


def tool_result(value):
    if not isinstance(value, dict) or value.get('isError'):
        raise TransferError('MCP tool failed; completion is unknown')
    return value


class HostProcess:
    """Own one child process group and bounded, deadline-limited JSON-lines I/O."""
    def __init__(self, command, cwd):
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.DEVNULL, start_new_session=True, cwd=cwd)
        self.buffer = bytearray()
        os.set_blocking(self.process.stdin.fileno(), False)
        self.deadline = time.monotonic() + TIMEOUT

    def close(self):
        try:
            os.killpg(self.process.pid, signal.SIGTERM)
        except ProcessLookupError:
            # The group has already exited; there is nothing left to signal.
            pass
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            # The grace period ended; the finally block escalates to SIGKILL.
            pass
        finally:
            # Leader exit does not imply descendant exit: terminate the remaining group too.
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                # No descendants remain after the graceful shutdown.
                pass
            try:
                self.process.wait(timeout=5)
            finally:
                self.process.stdin.close()
                self.process.stdout.close()

    def remaining(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TransferError('Host timed out; completion is unknown')
        return remaining

    def send(self, value):
        data = memoryview((json.dumps(value) + '\n').encode())
        if len(data) > MAX_MESSAGE:
            raise TransferError('Host request exceeds the file-tool limit')
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
            if len(self.buffer) >= MAX_MESSAGE:
                raise TransferError('Host response exceeds the file-tool limit')
            if not select.select([self.process.stdout], [], [], self.remaining())[0]:
                raise TransferError('Host timed out returning a result; completion is unknown')
            chunk = os.read(self.process.stdout.fileno(), 65536)
            if not chunk:
                raise TransferError('Host stopped before returning the tool result')
            start = len(self.buffer)
            self.buffer.extend(chunk)
            newline = self.buffer.find(b'\n', start)
        if newline >= MAX_MESSAGE:
            raise TransferError('Host response exceeds the file-tool limit')
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


class ClaudeHost:
    """Guard one file operation with Claude's execution hook and consume its raw result."""
    def __init__(self, server, cwd=None, mcp_config=None, plugin_dir=None):
        if not server or not re.fullmatch(r'[A-Za-z0-9_.:-]+', server):
            raise TransferError('Select an existing Claude MCP connection explicitly')
        self.server = server
        self.cwd = str(Path(cwd or Path.cwd()).absolute())
        self.options = []
        # Paths are opaque: only Claude opens configuration and resolves credential references.
        if mcp_config:
            self.options += ['--mcp-config', str(Path(mcp_config).absolute()), '--strict-mcp-config']
        if plugin_dir:
            self.options += ['--plugin-dir', str(Path(plugin_dir).absolute())]

    def __enter__(self):
        return self

    def __exit__(self, *error):
        pass

    def call(self, name, arguments):
        tool = 'mcp__' + re.sub(r'[^A-Za-z0-9_-]', '_', self.server) + '__' + name
        proposed = dict(arguments)
        if name == 'uploadFiles':
            proposed['body_base64'] = PLACEHOLDER
        elif name != 'downloadFiles':
            raise TransferError('Claude file handoff only supports uploadFiles and downloadFiles')
        command = ['claude', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
                   '--verbose', '--permission-prompt-tool', 'stdio', '--permission-mode', 'default',
                   '--max-turns', '1', '--tools', '', '--disable-slash-commands'] + self.options
        if name == 'uploadFiles':
            command.append('--no-session-persistence')
        # Downloads need a persistent host session: no-session-persistence assigns
        # result files a different ID, so they cannot be bound to the reported session.
        channel = HostProcess(command, self.cwd)
        try:
            return self.exchange(channel, tool, name, proposed, arguments)
        finally:
            channel.close()

    def exchange(self, channel, tool, name, proposed, arguments):
        channel.send({'type': 'control_request', 'request_id': 'initialize',
                      'request': {'subtype': 'initialize', 'hooks': {'PreToolUse': [
                          {'hookCallbackIds': [CLAUDE_GUARD], 'onFailure': 'block'}]}}})
        initialized = False
        approved = None
        permission_answered = False
        session_id = None
        while True:
            message = channel.receive()
            kind = message.get('type')
            if kind == 'system' and message.get('subtype') == 'init':
                actual = message.get('session_id')
                try:
                    uuid.UUID(actual)
                except (ValueError, TypeError, AttributeError):
                    raise TransferError('Claude did not identify its transfer session') from None
                if session_id is not None and session_id != actual:
                    raise TransferError('Claude changed its transfer session unexpectedly')
                session_id = actual
            elif kind == 'control_response':
                response = message.get('response', {})
                if initialized or response.get('request_id') != 'initialize' or response.get('subtype') != 'success':
                    raise TransferError('Claude control initialization failed')
                capabilities = response.get('response')
                if (not isinstance(capabilities, dict) or capabilities.get('hooks_applied') is not True
                        or capabilities.get('hook_on_failure_supported') is not True):
                    raise TransferError('Claude did not register a blocking execution hook; update Claude Code')
                initialized = True
                # No payload reaches the model; its only job is to propose the selected call once.
                prompt = ('Call this MCP tool exactly once with these exact arguments. Do not call other tools. '
                          'The execution hook supplies file bytes; do not generate or copy them.\n'
                          + json.dumps({'tool': tool, 'arguments': proposed}))
                channel.send({'type': 'user', 'message': {'role': 'user', 'content': prompt}})
            elif kind == 'control_request':
                request = message.get('request', {})
                hook = request.get('subtype') == 'hook_callback'
                call = request.get('input') if hook else request
                use_id = request.get('tool_use_id')
                server = call.get('mcp_server') if isinstance(call, dict) else None
                selected = (initialized and isinstance(use_id, str) and bool(use_id)
                            and isinstance(server, dict) and server.get('name') == self.server
                            and call.get('tool_name') == tool)
                refusal = 'Outside the single selected file operation'
                if hook:
                    valid = (selected and approved is None and request.get('callback_id') == CLAUDE_GUARD
                             and call.get('hook_event_name') == 'PreToolUse' and call.get('tool_input') == proposed)
                    output = {'hookEventName': 'PreToolUse', 'permissionDecision': 'deny',
                              'permissionDecisionReason': refusal}
                    if valid:
                        output = {'hookEventName': 'PreToolUse', 'permissionDecision': 'allow',
                                  'updatedInput': arguments}
                        approved = use_id
                    decision = {'hookSpecificOutput': output}
                else:
                    # A host ask rule may still prompt after the guard has checked and rewritten the call.
                    valid = (selected and not permission_answered and use_id == approved
                             and request.get('subtype') == 'can_use_tool' and call.get('input') == arguments)
                    decision = ({'behavior': 'allow', 'updatedInput': arguments} if valid else
                                {'behavior': 'deny', 'message': refusal})
                    permission_answered = valid
                channel.send({'type': 'control_response', 'response': {'subtype': 'success',
                              'request_id': message['request_id'], 'response': decision}})
                if not valid:
                    raise TransferError('Claude proposed an unexpected or repeated operation; no additional approval')
            elif kind == 'user':
                blocks = message.get('message', {}).get('content', [])
                if not isinstance(blocks, list):
                    continue
                for block in blocks:
                    if block.get('type') != 'tool_result':
                        continue
                    if not approved or block.get('tool_use_id') != approved or message.get('parent_tool_use_id'):
                        raise TransferError('Claude returned an unapproved or unrelated tool result')
                    if block.get('is_error'):
                        raise TransferError('Claude reported a failed MCP call; completion is unknown')
                    raw = message.get('tool_use_result')
                    if name == 'downloadFiles':
                        return self.download_result(raw, block.get('content'), session_id)
                    if isinstance(raw, dict):
                        tool_result(raw)
                    content = block.get('content')
                    if isinstance(content, str):
                        content = [{'type': 'text', 'text': content}]
                    return tool_result({'content': content})
            elif kind == 'result':
                if isinstance(message.get('result'), str) and message['result'].startswith('Not logged in'):
                    raise TransferError('Claude model session is not signed in; configure the child host login before transfer')
                raise TransferError('Claude ended without the approved MCP result; check authorization and host compatibility')

    def download_result(self, raw, content, session_id):
        tool_result(raw)
        if isinstance(raw.get('structuredContent'), dict):
            return raw
        # Large results can omit structuredContent too. Only read the output of our
        # new session while Claude is alive; never follow a model-supplied file path.
        if raw.get('structuredContentOmitted') is not True or not isinstance(content, str):
            raise TransferError('Claude did not provide the complete structured download result')
        match = re.match(r'^Error: result \([\d,]+ characters(?: across [\d,]+ lines?)?\) exceeds maximum allowed tokens\. '
                         r'Output has been saved to ([^\n]+)\.\nFormat: JSON', content)
        if not match:
            raise TransferError('Claude result-file notice is unsupported; download was not saved')
        path = Path(match[1])
        root = Path(os.environ.get('CLAUDE_CONFIG_DIR', str(Path.home() / '.claude'))).absolute() / 'projects'
        try:
            relative = path.relative_to(root)
        except ValueError:
            raise TransferError('Claude result file is outside its projects directory') from None
        if (not path.is_absolute() or '..' in path.parts or len(relative.parts) != 4
                or relative.parts[1:3] != (session_id, 'tool-results')
                or not re.fullmatch(r'mcp-[A-Za-z0-9_.:-]+\.txt', path.name)):
            raise TransferError('Claude result file does not belong to this transfer session')
        descriptor = open_node(path.anchor, directory=True)
        try:
            for component in path.parts[1:-1]:
                child = open_node(component, descriptor, directory=True)
                os.close(descriptor)
                descriptor = child
            with os.fdopen(open_node(path.name, descriptor), 'rb') as source:
                if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
                    raise TransferError('Claude saved result must be a regular file')
                data = source.read(MAX_MESSAGE + 1)
        finally:
            os.close(descriptor)
        if len(data) > MAX_MESSAGE:
            raise TransferError('Claude saved result exceeds the file-tool limit')
        try:
            value = json.loads(data)
        except ValueError:
            raise TransferError('Claude saved result is not complete JSON') from None
        return {'structuredContent': value}
