"""Request replay through the hosted API and a real guest process."""
from __future__ import annotations

import asyncio
import json
import uuid
import urllib.error
import urllib.request

import pytest

from conftest import collect_stream
from e2e_auth import auth_context


def keyed_post(path, body, key):
    auth = auth_context()
    request = urllib.request.Request(
        auth.url_for(auth.v1(path)),
        data=json.dumps(body).encode(),
        headers={**auth.auth_headers(content_type=True), "Idempotency-Key": key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def mcp_start(box_id, body, key):
    auth = auth_context()
    request = urllib.request.Request(
        f"{auth.url.removesuffix('/api')}/mcp",
        data=json.dumps({
            'jsonrpc': '2.0', 'id': str(uuid.uuid4()), 'method': 'tools/call',
            'params': {'name': 'startExecution', 'arguments': {
                'box_id': box_id, 'body': body, 'Idempotency-Key': key, 'wait': False,
            }},
        }).encode(),
        headers={**auth.auth_headers(content_type=True),
                 'Accept': 'application/json, text/event-stream',
                 'MCP-Protocol-Version': '2025-06-18'},
        method='POST',
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        text = response.read().decode()
    if text.startswith('event:') or text.startswith('data:'):
        text = next(line[5:].strip() for line in text.splitlines() if line.startswith('data:'))
    envelope = json.loads(text)
    assert 'error' not in envelope, envelope
    result = envelope['result']
    assert not result.get('isError'), result
    return result.get('structuredContent') or json.loads(result['content'][0]['text'])


@pytest.mark.parametrize('transport', ['rest', 'mcp'])
@pytest.mark.asyncio
async def test_execution_replay_preserves_one_counter_effect_and_identity(box, transport):
    counter = f"/tmp/idempotency-{uuid.uuid4().hex}"
    key = str(uuid.uuid4())
    body = {"command": "sh", "args": ["-c", f"echo once >> {counter}"]}
    async def start():
        if transport == 'mcp':
            return await asyncio.to_thread(mcp_start, box.id, body, key)
        status, result = await asyncio.to_thread(keyed_post, f"boxes/{box.id}/exec", body, key)
        assert status == 201, result
        return result

    first = await start()
    # Poll terminal status without taking output ownership; this also covers
    # a short command whose startup response arrives after it has exited.
    from e2e_auth import request_json
    for _ in range(100):
        status, terminal = await asyncio.to_thread(
            request_json, "GET", auth_context().v1(f"boxes/{box.id}/executions/{first['execution_id']}")
        )
        assert status == 200, terminal
        if terminal.get("status") == "completed":
            break
        await asyncio.sleep(0.05)
    else:
        pytest.fail("counter command did not complete")
    replay = await start()
    assert replay == first, replay
    status, mismatch = await asyncio.to_thread(
        keyed_post, f"boxes/{box.id}/exec", {"command": "false"}, key
    )
    assert status == 422, mismatch
    check = await box.exec("cat", [counter], None)
    output = await collect_stream(check.stdout())
    assert (await asyncio.wait_for(check.wait(), 15)).exit_code == 0
    assert output == "once\n", "retry repeated command effects"
