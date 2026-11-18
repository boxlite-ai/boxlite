#!/usr/bin/env python3
"""Exercise the shared production MCP contract with an explicitly supplied API key."""
import base64
import io
import json
import os
from pathlib import Path
import tarfile
import time
import urllib.error
import urllib.request
import uuid

ENDPOINT = 'https://api.boxlite.ai/mcp'


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        raise RuntimeError('MCP redirect refused; credentials remain bound to the production endpoint')


class McpClient:
    """A bounded acceptance client, not a plugin runtime or OAuth credential broker."""
    def __init__(self, token):
        if not token or any(character.isspace() for character in token):
            raise ValueError('A nonempty API key is required; OAuth fallback is forbidden')
        self.headers = {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
                        'Accept': 'application/json, text/event-stream'}
        self.opener = urllib.request.build_opener(NoRedirect())
        self.sequence = 0

    def request(self, method, params=None, notification=False):
        self.sequence += 1
        payload = {'jsonrpc': '2.0', 'method': method}
        if not notification:
            payload['id'] = self.sequence
        if params is not None:
            payload['params'] = params
        request = urllib.request.Request(ENDPOINT, json.dumps(payload).encode(), self.headers)
        try:
            with self.opener.open(request, timeout=120) as response:
                if response.headers.get('Mcp-Session-Id'):
                    self.headers['Mcp-Session-Id'] = response.headers['Mcp-Session-Id']
                body = response.read(16 * 1024 * 1024 + 1)
                content_type = response.headers.get('Content-Type', '')
        except urllib.error.HTTPError as error:
            raise RuntimeError(f'MCP HTTP {error.code} during {method}; no retry or authentication fallback') from None
        if len(body) > 16 * 1024 * 1024:
            raise RuntimeError('MCP response exceeded the acceptance limit')
        if notification and not body:
            return None
        if 'text/event-stream' in content_type:
            messages = [json.loads(line[6:]) for line in body.decode().splitlines() if line.startswith('data: ')]
            value = next((item for item in messages if item.get('id') == self.sequence), {})
        else:
            value = json.loads(body)
        if value.get('id') != self.sequence or 'error' in value:
            raise RuntimeError(f'MCP protocol failure during {method}')
        return value['result']

    def connect(self):
        result = self.request('initialize', {'protocolVersion': '2025-03-26', 'capabilities': {},
                                             'clientInfo': {'name': 'boxlite-plugin-acceptance', 'version': '0.2.0'}})
        self.headers['MCP-Protocol-Version'] = result['protocolVersion']
        self.request('notifications/initialized', notification=True)
        return self.request('tools/list')['tools']

    def call(self, name, arguments, error=False):
        result = self.request('tools/call', {'name': name, 'arguments': arguments})
        if bool(result.get('isError')) != error:
            raise RuntimeError(f'{name}: unexpected MCP error status')
        if error:
            return result
        if 'structuredContent' in result:
            return result['structuredContent']
        content = result.get('content', [])
        return json.loads(content[0]['text']) if content and content[0]['text'].startswith(('{', '[')) else result


def archive_bytes(content):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w') as archive:
        member = tarfile.TarInfo('message.txt')
        member.size = len(content)
        member.mode = 0o644
        archive.addfile(member, io.BytesIO(content))
    return base64.b64encode(buffer.getvalue()).decode()


def exercise(client, report, *, expected_sub, expected_path_prefix):
    if not expected_sub or not expected_path_prefix:
        raise RuntimeError('Set BOXLITE_EXPECTED_SUB and BOXLITE_EXPECTED_PATH_PREFIX for the dedicated test account and organization')
    tools = client.connect()
    report['tools'] = [tool['name'] for tool in tools]
    report['review_findings'] = [tool['name'] + ': missing title' for tool in tools
                                  if not (tool.get('title') or tool.get('annotations', {}).get('title'))]
    if 'invoke_api_endpoint' in report['tools']:
        report['review_findings'].append('Review catch-all invoke_api_endpoint against Claude read/write separation requirement')
    required = {'createBox', 'getBox', 'startExecution', 'uploadFiles', 'downloadFiles', 'stopBox', 'removeBox',
                'read_api_endpoint', 'write_api_endpoint', 'get_api_endpoint_schema'}
    if not required.issubset(report['tools']):
        raise RuntimeError('Required tools were not discovered')
    client.call('get_api_endpoint_schema', {'operationId': 'getCurrentPrincipal'})
    principal = client.call('read_api_endpoint', {'operationId': 'getCurrentPrincipal'})
    if not isinstance(principal, dict) or principal.get('sub') != expected_sub or principal.get('path_prefix') != expected_path_prefix:
        raise RuntimeError('Cloud identity or organization differs from the expected test context; no workload was created')
    report['checks'].append('expected-principal-and-organization')
    name = 'plugin-check-' + uuid.uuid4().hex[:12]
    report['resource_name'] = name
    box = None
    try:
        created = client.call('createBox', {'body': {'name': name, 'image': 'python', 'cpus': 1,
                              'memory_mib': 512, 'network': {'inbound': {'mode': 'enabled'}}}})
        box = created['box_id']
        report['box_id'] = box
        report['checks'].append('createBox')

        def execute(code, expected=0):
            value = client.call('startExecution', {'box_id': box, 'body': {'command': 'python3',
                                'args': ['-c', code], 'timeout_seconds': 30}, 'wait': True, 'wait_timeout_seconds': 60})
            if value.get('complete') is not True or value.get('exit_code') != expected:
                raise RuntimeError('Execution incomplete or exit code unexpected; inspect before retry')
            return value.get('stdout', '')

        if execute("print('hello')").strip() != 'hello':
            raise RuntimeError('Hello output mismatch')
        execute('import sys; sys.exit(7)', expected=7)
        report['checks'] += ['hello-output-and-exit', 'nonzero-exit-reported']
        execute("from pathlib import Path; Path('/workspace/plugin-check').mkdir(exist_ok=True)")
        destination = '/workspace/plugin-check'
        upload = {'box_id': box, 'path': destination, 'body_base64': archive_bytes(b'version-one\n')}
        client.call('uploadFiles', upload)
        downloaded = client.call('downloadFiles', {'box_id': box, 'path': destination + '/message.txt'})
        with tarfile.open(fileobj=io.BytesIO(base64.b64decode(downloaded['base64']))) as archive:
            members = [member for member in archive if member.isfile()]
            if len(members) != 1:
                raise RuntimeError('File roundtrip returned unexpected members')
            actual = archive.extractfile(members[0]).read()
        if actual != b'version-one\n':
            raise RuntimeError('File roundtrip returned unexpected content')
        report['checks'].append('archive-roundtrip')
        server = client.call('startExecution', {'box_id': box, 'body': {'command': 'python3',
                             'args': ['-m', 'http.server', '8000', '--directory', destination]}, 'wait': False})
        report['app_execution_id'] = server['execution_id']
        client.call('get_api_endpoint_schema', {'operationId': 'prepareTunnel'})
        tunnel = client.call('write_api_endpoint', {'operationId': 'prepareTunnel',
                             'arguments': {'box_id': box, 'port': 8000, 'body': {'isPublic': True}}})
        report['tunnel_fields'] = sorted(tunnel)
        public_url = tunnel['uri']
        report['public_url'] = public_url
        if not public_url.startswith('https://'):
            raise RuntimeError('Tunnel did not return HTTPS')

        def public_content(expected):
            deadline = time.monotonic() + 45
            while True:
                try:
                    with urllib.request.urlopen(public_url.rstrip('/') + '/message.txt', timeout=10) as response:
                        if response.read(1024) == expected:
                            return
                except (urllib.error.URLError, TimeoutError):
                    # The guest server or tunnel may still be starting; retry until the deadline below.
                    pass
                if time.monotonic() >= deadline:
                    raise RuntimeError('Public application content did not match before deadline')
                time.sleep(1)

        public_content(b'version-one\n')
        report['checks'].append('public-app-feature')
        execute("from pathlib import Path; Path('/workspace/plugin-check/persistent.txt').write_text('keep')")
        client.call('uploadFiles', {**upload, 'body_base64': archive_bytes(b'version-two\n')})
        if client.call('getBox', {'box_id': box})['box_id'] != box:
            raise RuntimeError('Box identity changed')
        if execute("from pathlib import Path; print(Path('/workspace/plugin-check/persistent.txt').read_text())").strip() != 'keep':
            raise RuntimeError('Persistent data changed')
        report['checks'].append('update-preserves-box-and-data')
        public_content(b'version-two\n')
        report['checks'].append('same-url-serves-updated-app')
        missing = client.call('getBox', {'box_id': 'plugin-missing-' + uuid.uuid4().hex}, error=True)
        if missing.get('structuredContent', {}).get('statusCode') != 404:
            raise RuntimeError('Unknown Box did not return not-found')
        report['checks'].append('unknown-box-rejected')
    finally:
        if box:
            try:
                client.call('stopBox', {'box_id': box})
                deadline = time.monotonic() + 45
                while client.call('getBox', {'box_id': box})['status'] != 'stopped':
                    if time.monotonic() >= deadline:
                        raise RuntimeError('Box did not stop before cleanup deadline')
                    time.sleep(1)
                client.call('removeBox', {'box_id': box, 'force': True})
                missing = client.call('getBox', {'box_id': box}, error=True)
                if missing.get('structuredContent', {}).get('statusCode') != 404:
                    raise RuntimeError('Removal could not be verified as not-found')
                report['checks'].append('explicit-id-cleanup-verified')
                report['cleanup'] = 'passed'
            except Exception:
                report['cleanup'] = 'failed; inspect recorded box_id'
                raise
        else:
            report['cleanup'] = 'creation outcome unknown; inspect recorded resource_name before retry'


def main():
    report = {'mode': 'cloud-api', 'transport': 'production MCP', 'checks': [], 'status': 'failed',
              'started_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}
    output = Path('target/plugins/evidence/cloud-api.json')
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        exercise(McpClient(os.environ.get('BOXLITE_API_KEY', '')), report,
                 expected_sub=os.environ.get('BOXLITE_EXPECTED_SUB', ''),
                 expected_path_prefix=os.environ.get('BOXLITE_EXPECTED_PATH_PREFIX', ''))
        report['status'] = 'failed' if report.get('failures') else 'passed'
    except Exception as error:
        # Raw server/transport exceptions can contain request data; never log them.
        report['failure'] = str(error) if isinstance(error, RuntimeError) else type(error).__name__
    finally:
        descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(report, stream, indent=2)
        print(f"Cloud API-key MCP acceptance: {report['status']}; private evidence: {output}")
    return 0 if report['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
