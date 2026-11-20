#!/usr/bin/env python3
"""Recording host-protocol peer, never used as native-client or production evidence."""
import base64
import json
from pathlib import Path
import sys
import uuid
session = str(uuid.uuid4())

root = Path(sys.argv[0]).parent
fault = (root / 'fault').read_text() if (root / 'fault').exists() else ''
claude = Path(sys.argv[0]).name == 'claude'
if claude:
    (root / 'claude-launch.json').write_text(json.dumps({'cwd': str(Path.cwd()), 'args': sys.argv[1:]}))


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


def finish_claude(name, arguments):
    result = execute(name, arguments)
    if fault == 'repeat':
        emit({'type': 'control_request', 'request_id': 'second', 'request': request})
        return
    if fault == 'raw-tool-error':
        result['isError'] = True
    content = [] if fault == 'empty-ack' else result['content']
    if fault == 'missing-structured':
        result.pop('structuredContent', None)
    if fault.startswith('persisted'):
        saved = root / 'claude-results/projects/fixture' / session / 'tool-results/mcp-fixture-downloadFiles-1.txt'
        saved.parent.mkdir(parents=True, exist_ok=True)
        saved.write_text(json.dumps(result['structuredContent']))
        if fault == 'persisted-link':
            target = root / 'outside.json'
            saved.rename(target)
            saved.symlink_to(target)
        content = ('Error: result (1,000,000 characters) exceeds maximum allowed tokens. '
                   + 'Output has been saved to ' + str(saved) + '.\nFormat: JSON with schema: {base64: string}')
        result = {'structuredContentOmitted': True}
    emit({'type': 'user', 'parent_tool_use_id': None, 'tool_use_result': result,
          'message': {'content': [{'type': 'tool_result', 'tool_use_id': 'use-1',
                                   'content': content, 'is_error': fault == 'tool-error'}]}})
    emit({'type': 'result', 'subtype': 'error_max_turns'})


for line in sys.stdin:
    message = json.loads(line)
    if claude:
        if message.get('type') == 'control_request':
            hook = next(iter(message['request'].get('hooks', {}).get('PreToolUse', [])), {})
            hooks_applied = bool(hook) and fault != 'hooks-ignored'
            blocked_on_failure = hook.get('onFailure') == 'block' and fault != 'hook-failure-unsupported'
            emit({'type': 'control_response', 'response': {'request_id': 'initialize', 'subtype': 'success',
                  'response': {'hooks_applied': hooks_applied, 'hook_on_failure_supported': blocked_on_failure}}})
            emit({'type': 'system', 'subtype': 'init', 'session_id': session})
        elif message.get('type') == 'user':
            proposal = json.loads(message['message']['content'].split('\n')[-1])
            (root / 'model-input.json').write_text(json.dumps(proposal))
            tool = proposal['tool']
            name = tool.split('__')[-1]
            if fault == 'not-logged-in':
                emit({'type': 'result', 'result': 'Not logged in · Please run /login'})
                continue
            if fault == 'no-callback':
                emit({'type': 'result', 'subtype': 'success', 'result': 'Uploaded successfully!'})
                continue
            request = {'subtype': 'can_use_tool', 'tool_name': tool,
                       'mcp_server': {'name': 'chosen-server'}, 'input': proposal['arguments'], 'tool_use_id': 'use-1'}
            if fault in ('wrong-target', 'managed-wrong-target'):
                request['input']['path'] = '/wrong'
            if fault == 'wrong-tool':
                request['tool_name'] = 'mcp__other__removeBox'
            if fault == 'wrong-server':
                request['mcp_server']['name'] = 'other'
            if hooks_applied:
                request = {'subtype': 'hook_callback', 'callback_id': hook['hookCallbackIds'][0],
                           'tool_use_id': 'use-1',
                           'input': {'hook_event_name': 'PreToolUse', 'tool_name': request['tool_name'],
                                     'tool_input': request['input'], 'mcp_server': request['mcp_server']}}
                emit({'type': 'control_request', 'request_id': 'guard', 'request': request})
            elif fault in ('managed-wrong-target', 'hooks-ignored', 'hook-failure-unsupported'):
                finish_claude(name, request['input'])
            elif fault == 'managed-deny':
                emit({'type': 'result', 'subtype': 'error_max_turns'})
            else:
                emit({'type': 'control_request', 'request_id': 'approval', 'request': request})
        elif message.get('type') == 'control_response':
            decision = message['response']['response']
            if message['response']['request_id'] in ('guard', 'second') and 'hookSpecificOutput' in decision:
                decision = decision['hookSpecificOutput']
                if decision['permissionDecision'] != 'allow':
                    continue
                if fault == 'managed-deny':
                    emit({'type': 'result', 'subtype': 'error_max_turns'})
                    continue
                if fault == 'managed-ask':
                    emit({'type': 'control_request', 'request_id': 'approval', 'request': {
                         'subtype': 'can_use_tool', 'tool_name': tool, 'input': decision['updatedInput'],
                         'mcp_server': {'name': 'chosen-server'}, 'tool_use_id': 'use-1'}})
                    continue
                finish_claude(name, decision['updatedInput'])
                continue
            with (root / 'decisions.jsonl').open('a') as output:
                output.write(json.dumps({'behavior': decision['behavior']}) + '\n')
            if decision['behavior'] != 'allow':
                continue
            finish_claude(name, decision['updatedInput'])
    else:
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
