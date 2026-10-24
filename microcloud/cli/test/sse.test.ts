import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSse } from '../src/sse.js';

async function* chunks(parts: string[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield new TextEncoder().encode(p);
}

async function collect(parts: string[]) {
  const out = [];
  for await (const ev of parseSse(chunks(parts))) out.push(ev);
  return out;
}

test('parses events split across chunks, with ids, comments and CRLF', async () => {
  const events = await collect(['id: 1\nevent: step\ndata: {"name":"bu', 'ild"}\n\n: keep-alive\r\n\r\nevent: log\r\ndata: a\r\ndata: b\r\n\r\n', 'data: tail']);
  assert.deepEqual(events, [
    { id: '1', event: 'step', data: '{"name":"build"}' },
    { id: '1', event: 'log', data: 'a\nb' },
    { id: '1', event: 'message', data: 'tail' },
  ]);
});

test('ignores empty streams and strips one leading space from values', async () => {
  assert.deepEqual(await collect([]), []);
  assert.deepEqual(await collect(['data:  two spaces\n\n']), [{ event: 'message', data: ' two spaces' }]);
});
