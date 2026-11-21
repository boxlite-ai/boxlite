#!/usr/bin/env python3
"""Recording host-protocol peer, never used as native-client or production evidence."""
import base64
import json
from pathlib import Path
import sys

root = Path(sys.argv[0]).parent
fault = (root / 'fault').read_text() if (root / 'fault').exists() else ''
if Path(sys.argv[0]).name == 'claude':
    (root / 'claude-launch.json').touch()
    sys.exit(1)


def emit(value):
    print(json.dumps(value), flush=True)


def execute(name, arguments):
    with (root / 'calls.jsonl').open('a') as output:
        output.write(json.dumps({'tool': name, 'arguments': arguments}) + '\n')
    if name == 'uploadFiles':
        (root / 'uploaded.tar').write_bytes(base64.b64decode(arguments['body_base64'], validate=True))
        return {'content': [{'type': 'text', 'text': 'HTTP 204'}], 'isError': False}
    return {'structuredContent': {'base64': base64.b64encode((root / 'uploaded.tar').read_bytes()).decode()},
            'content': [{'type': 'text', 'text': 'display truncated by host'}], 'isError': False}


for line in sys.stdin:
    message = json.loads(line)
    if 'id' not in message:
        continue
    method = message.get('method')
    if method == 'initialize':
        result = {}
    elif method == 'thread/start':
        assert message['params']['ephemeral'] is True
        result = {'thread': {'id': 'fixture-thread'}}
    elif method == 'mcpServer/tool/call':
        if fault == 'eof':
            sys.exit(0)
        if fault == 'json':
            print('bad JSON', flush=True)
            continue
        if fault == 'error':
            emit({'id': message['id'], 'error': {'code': -32601}})
            continue
        if fault == 'interaction':
            emit({'id': 'approval', 'method': 'tool/requestUserInput', 'params': {}})
            continue
        params = message['params']
        assert params['server'] == 'chosen-server'
        result = execute(params['tool'], params['arguments'])
        if fault == 'empty-ack':
            result = {}
    else:
        continue
    emit({'id': message['id'], 'result': result})
