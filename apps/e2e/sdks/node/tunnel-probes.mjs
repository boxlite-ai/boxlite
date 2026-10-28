import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'

// Each pending read has a deadline and releases its timer on completion.
export async function read(socket, size) {
  let timer
  try {
    return await Promise.race([
      socket.read(size),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('tunnel read timed out')), 10_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export async function readHttp(socket) {
  let response = Buffer.alloc(0)
  for (;;) {
    const chunk = await read(socket, 64 * 1024)
    assert(chunk.length, 'tunnel closed before the complete HTTP response')
    response = Buffer.concat([response, chunk])
    assert(response.length <= 8 * 1024 * 1024, 'HTTP response exceeds probe limit')
    const boundary = response.indexOf('\r\n\r\n')
    if (boundary < 0) {
      assert(response.length <= 65536, 'HTTP headers exceed probe limit')
      continue
    }
    const headers = response.subarray(0, boundary).toString('latin1')
    assert.match(headers, /^HTTP\/1\.[01] 200 /)
    const lengths = [...headers.matchAll(/^content-length:\s*(\d+)\s*$/gim)]
    assert.equal(lengths.length, 1, 'expected one Content-Length')
    const size = boundary + 4 + Number(lengths[0][1])
    assert(size <= 8 * 1024 * 1024, 'declared response exceeds probe limit')
    if (response.length >= size) {
      assert.equal(response.length, size, 'unexpected bytes after HTTP response')
      return response
    }
  }
}

export async function websocketEcho(socket, marker) {
  const key = randomBytes(16).toString('base64')
  await socket.write(
    Buffer.from(
      'GET /ws HTTP/1.1\r\nHost: tunnel.test\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    ),
  )
  let headers = Buffer.alloc(0)
  while (!headers.includes('\r\n\r\n')) {
    const chunk = await read(socket, 4096)
    assert(chunk.length, 'WebSocket closed before upgrade')
    headers = Buffer.concat([headers, chunk])
    assert(headers.length <= 65536, 'WebSocket headers exceed probe limit')
  }
  const text = headers.toString('latin1')
  assert.match(text, /^HTTP\/1\.1 101 /)
  const accept = createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64')
  assert.equal(text.match(/^sec-websocket-accept:\s*(.*)$/im)?.[1].trim(), accept)
  const payload = Buffer.from('node-ws')
  const mask = randomBytes(4)
  await socket.write(
    Buffer.concat([
      Buffer.from([0x81, 0x80 | payload.length]),
      mask,
      Buffer.from(payload.map((value, index) => value ^ mask[index % 4])),
    ]),
  )
  async function exact(size) {
    let bytes = Buffer.alloc(0)
    while (bytes.length < size) {
      const chunk = await read(socket, size - bytes.length)
      assert(chunk.length, 'WebSocket closed before echo')
      bytes = Buffer.concat([bytes, chunk])
    }
    return bytes
  }
  const frame = await exact(2)
  assert.equal(frame[0], 0x81, 'expected a final text frame')
  assert(frame[1] < 126, 'unexpected echo frame length or mask')
  assert.equal((await exact(frame[1])).toString(), `${marker}:node-ws`, 'WebSocket echo mismatch')
}
