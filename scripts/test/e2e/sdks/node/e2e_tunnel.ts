// REST E2E driver for the Node SDK's public box.network.tunnel(port) API.

import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ApiKeyCredential, BoxliteRestOptions, JsBoxlite, SimpleBox } from '../../../../../sdks/node'

const SERVICES = [
  { port: 18081, marker: 'node-sdk-tunnel-e2e-a' },
  { port: 18083, marker: 'node-sdk-tunnel-e2e-b' },
] as const
const SERVER = readFileSync(resolve(__dirname, '../../fixtures/service_in_box_server.py')).toString('base64')

function env(name: string, fallback: string): string {
  const value = process.env[name]
  return value && value.length ? value : fallback
}

async function requestOverTunnel(
  box: SimpleBox,
  port: number,
  request: Buffer | string,
  marker?: string,
  readDelay = 0,
): Promise<Buffer> {
  const tunnel = await box.network.tunnel(port)
  const endpoint = tunnel.endpoint()
  if (typeof endpoint !== 'string') {
    throw new Error('expected REST tunnel endpoint URL for the cloud box')
  }
  const socket = await tunnel.connect()
  const chunks: Buffer[] = []
  try {
    await socket.write(Buffer.isBuffer(request) ? request : Buffer.from(request))
    if (readDelay) await delay(readDelay)
    while (true) {
      const chunk = await Promise.race([
        socket.read(64 * 1024),
        delay(5_000).then(() => { throw new Error('HTTP response timed out') }),
      ])
      if (!chunk.length) break
      chunks.push(chunk)
      if (marker && Buffer.concat(chunks).includes(marker)) break
    }
    return Buffer.concat(chunks)
  } finally {
    await socket.close()
  }
}

async function getOverTunnel(box: SimpleBox, port: number, marker: string): Promise<string> {
  return (await requestOverTunnel(box, port, 'GET / HTTP/1.0\r\nHost: tunnel.test\r\n\r\n', marker)).toString()
}

async function startService(box: SimpleBox, port: number, marker: string): Promise<string> {
  const command =
    `python3 -u -c "import base64;exec(base64.b64decode('${SERVER}'))" ${port} ${marker} ` +
    `>/tmp/tunnel-${port}.log 2>&1 & echo $!`
  const result = await box.exec('sh', ['-lc', command])
  if (result.exitCode !== 0) throw new Error(`failed to start service: ${result.stderr}`)
  return result.stdout.trim()
}

async function websocketEcho(box: SimpleBox, port: number, marker: string): Promise<void> {
  const socket = await (await box.network.tunnel(port)).connect()
  const key = randomBytes(16).toString('base64')
  let response = Buffer.alloc(0)
  try {
    await socket.write(Buffer.from(
      `GET /ws HTTP/1.1\r\nHost: tunnel.test\r\nUpgrade: websocket\r\n` +
        `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    ))
    const payload = Buffer.from('node-ws')
    const mask = Buffer.from([1, 2, 3, 4])
    const masked = Buffer.from(payload.map((value, index) => value ^ mask[index % 4]))
    await socket.write(Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]))
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      response = Buffer.concat([response, await socket.read(4096)])
      if (response.includes('\r\n\r\n') && response.includes(`${marker}:node-ws`)) break
    }
  } finally {
    await socket.close()
  }
  if (!response.toString().startsWith('HTTP/1.1 101')) {
    throw new Error('WebSocket upgrade did not return 101')
  }
}

async function waitForHttp(box: SimpleBox, port: number, marker: string): Promise<string> {
  const deadline = Date.now() + 30_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const response = await getOverTunnel(box, port, marker)
      if (response.includes(marker)) return response
      lastError = new Error(`unexpected HTTP response: ${response}`)
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }
  throw new Error(`guest HTTP service was not reachable through tunnel: ${String(lastError)}`)
}

async function main(): Promise<void> {
  const runtime = JsBoxlite.rest(
    new BoxliteRestOptions({
      url: env('BOXLITE_E2E_URL', 'http://localhost:3000/api'),
      credential: new ApiKeyCredential(env('BOXLITE_E2E_API_KEY', 'devkey')),
      pathPrefix: env('BOXLITE_E2E_PREFIX', ''),
    }),
  )
  const box = new SimpleBox({
    image: env('BOXLITE_E2E_IMAGE', 'ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3'),
    autoRemove: true,
    runtime,
  })

  try {
    const failures: string[] = []
    await box.exec('true')
    const pids = await Promise.all(SERVICES.map(({ port, marker }) => startService(box, port, marker)))
    await waitForHttp(box, SERVICES[0].port, SERVICES[0].marker)
    const preparedTunnel = await box.network.tunnel(SERVICES[0].port)

    const requests = SERVICES.flatMap((service) =>
      Array.from({ length: 3 }, () => waitForHttp(box, service.port, service.marker)),
    )
    const responses = await Promise.all(requests)
    for (const [index, response] of responses.entries()) {
      const service = SERVICES[Math.floor(index / 3)]
      if (!response.startsWith('HTTP/1.0 200') && !response.startsWith('HTTP/1.1 200')) {
        throw new Error(`unexpected HTTP status: ${response.slice(0, 80)}`)
      }
      if (SERVICES.some(({ marker }) => marker !== service.marker && response.includes(marker))) {
        throw new Error(`cross-port response leaked into port ${service.port}`)
      }
    }

    const preparedSocket = await preparedTunnel.connect()
    await preparedSocket.write(Buffer.from('GET / HTTP/1.0\r\nHost: tunnel.test\r\n\r\n'))
    let prepared = ''
    while (!prepared.includes(SERVICES[0].marker)) {
      prepared += (await preparedSocket.read(8192)).toString()
    }
    await preparedSocket.close()
    if (!prepared.includes(SERVICES[0].marker)) {
      throw new Error('prepared tunnel did not reach the running service')
    }

    const postBody = Buffer.alloc(256 * 1024, 'n')
    const post = await requestOverTunnel(
      box,
      SERVICES[0].port,
      Buffer.concat([
        Buffer.from(`POST / HTTP/1.0\r\nHost: tunnel.test\r\nContent-Length: ${postBody.length}\r\n\r\n`),
        postBody,
      ]),
    )
    const digest = createHash('sha256').update(postBody).digest('hex')
    if (!post.includes(digest)) throw new Error('POST body digest mismatch')

    const large = await requestOverTunnel(box, SERVICES[0].port, 'GET /large HTTP/1.0\r\nHost: tunnel.test\r\n\r\n')
    if (large.length <= 2 * 1024 * 1024) throw new Error('large response was truncated')
    await websocketEcho(box, SERVICES[0].port, SERVICES[0].marker)

    const slow = await requestOverTunnel(
      box,
      SERVICES[0].port,
      'GET /slow HTTP/1.0\r\nHost: tunnel.test\r\n\r\n',
      undefined,
      1_000,
    )
    if (slow.length <= 2 * 1024 * 1024) throw new Error('slow response was truncated')

    const cancelled = await (await box.network.tunnel(SERVICES[0].port)).connect()
    await cancelled.close()
    await waitForHttp(box, SERVICES[0].port, SERVICES[0].marker)
    await Promise.all(
      Array.from({ length: 16 }, (_, index) => {
        const service = SERVICES[index % SERVICES.length]
        return waitForHttp(box, service.port, service.marker)
      }),
    )

    await box.exec('kill', [pids[0]])
    pids[0] = await startService(box, SERVICES[0].port, SERVICES[0].marker)
    await waitForHttp(box, SERVICES[0].port, SERVICES[0].marker)
    const restartTunnel = await box.network.tunnel(SERVICES[0].port)
    const restartSocket = await restartTunnel.connect()
    await restartSocket.write(Buffer.from('GET / HTTP/1.0\r\nHost: tunnel.test\r\n\r\n'))
    let restarted = ''
    while (!restarted.includes(SERVICES[0].marker)) {
      restarted += (await restartSocket.read(8192)).toString()
    }
    await restartSocket.close()
    if (!restarted.includes(SERVICES[0].marker)) {
      throw new Error('new tunnel did not reach the restarted service')
    }

    await box.stop()
    let stoppedTunnelRejected = false
    try {
      await box.network.tunnel(SERVICES[0].port)
    } catch {
      stoppedTunnelRejected = true
    }
    if (!stoppedTunnelRejected) {
      failures.push('tunnel establishment succeeded after box.stop()')
    }

    const isolatedBoxes = ['node-box-a', 'node-box-b'].map(
      () =>
        new SimpleBox({
          image: env('BOXLITE_E2E_IMAGE', 'ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3'),
          autoRemove: true,
          runtime,
        }),
    )
    try {
      await Promise.all(isolatedBoxes.map((isolatedBox) => isolatedBox.exec('true')))
      await Promise.all(
        isolatedBoxes.map((isolatedBox, index) => startService(isolatedBox, SERVICES[0].port, `node-box-${index}`)),
      )
      const isolated = await Promise.all(
        isolatedBoxes.map((isolatedBox, index) => waitForHttp(isolatedBox, SERVICES[0].port, `node-box-${index}`)),
      )
      if (isolated[0].includes('node-box-1') || isolated[1].includes('node-box-0')) {
        throw new Error('cross-box tunnel routing leaked')
      }
    } finally {
      await Promise.all(isolatedBoxes.map((isolatedBox) => isolatedBox.stop().catch(() => undefined)))
    }

    const halfCloseBox = new SimpleBox({
      image: env('BOXLITE_E2E_IMAGE', 'ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3'),
      autoRemove: true,
      runtime,
    })
    try {
      await halfCloseBox.exec('true')
      await startService(halfCloseBox, SERVICES[0].port, SERVICES[0].marker)
      await waitForHttp(halfCloseBox, SERVICES[0].port, SERVICES[0].marker)
      const halfCloseSocket = await (await halfCloseBox.network.tunnel(SERVICES[0].port)).connect()
      await halfCloseSocket.write(Buffer.from('GET / HTTP/1.0\r\nHost: tunnel.test\r\n\r\n'))
      await halfCloseSocket.shutdownWrite()
      let halfCloseResponse = ''
      while (true) {
        const chunk = await halfCloseSocket.read(8192)
        if (!chunk.length) break
        halfCloseResponse += chunk.toString()
      }
      await halfCloseSocket.close()
      if (!halfCloseResponse.includes(SERVICES[0].marker)) {
        failures.push('half-closed tunnel dropped the guest response')
      }
    } finally {
      await halfCloseBox.stop().catch(() => undefined)
    }
    console.log(
      'TUNNEL_HTTP=ok TUNNEL_WS=ok TUNNEL_MULTIPORT=ok TUNNEL_CONCURRENT=ok ' +
        'TUNNEL_LARGE=ok TUNNEL_RESTART=ok TUNNEL_BOX_ISOLATION=ok',
    )
    console.log(failures.length ? `TUNNEL_FAILURES=${failures.join('; ')}` : 'TUNNEL_LIFECYCLE=ok')
    if (failures.length) throw new Error(failures.join('; '))
  } finally {
    await box.stop().catch(() => undefined)
    runtime.close()
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
