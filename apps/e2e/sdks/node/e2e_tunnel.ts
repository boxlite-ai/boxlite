// POL-1221: independent REST-backed transport and lifecycle scenarios.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { SocketAddress } from 'node:net'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ApiKeyCredential, BoxliteRestOptions, JsBoxlite, SimpleBox } from '../../../../sdks/node'
import { DEFAULT_BOX_IMAGE } from '../../../../scripts/test/image.js'
import { read, readHttp, websocketEcho } from './tunnel-probes.mjs'

const SERVICES = [
  { port: 18081, marker: 'node-sdk-tunnel-e2e-a' },
  { port: 18083, marker: 'node-sdk-tunnel-e2e-b' },
] as const
const SERVER = readFileSync(resolve(__dirname, '../../fixtures/service_in_box_server.py')).toString('base64')
const EGRESS = readFileSync(resolve(__dirname, '../../fixtures/egress_probe.py'), 'utf8')
const GET = Buffer.from('GET / HTTP/1.0\r\nHost: tunnel.test\r\n\r\n')

function env(name: string, fallback: string): string {
  return process.env[name] || fallback
}

async function request(box: SimpleBox, port: number, bytes: Buffer = GET, readDelay = 0): Promise<Buffer> {
  const tunnel = await box.network.tunnel(new SocketAddress({ port }))
  assert(tunnel.uri(), 'REST prepare must return a URI')
  const socket = await tunnel.connect()
  try {
    await socket.write(bytes)
    if (readDelay) await delay(readDelay)
    return await readHttp(socket)
  } finally {
    await socket.close()
  }
}

async function startService(box: SimpleBox, port: number, marker: string): Promise<string> {
  const result = await box.exec('sh', [
    '-lc',
    `python3 -u -c "import base64;exec(base64.b64decode('${SERVER}'))" ${port} ${marker} ` +
      `>/tmp/tunnel-${port}.log 2>&1 & echo $!`,
  ])
  assert.equal(result.exitCode, 0, 'guest server launch failed')
  assert.match(result.stdout.trim(), /^\d+$/)
  const deadline = Date.now() + 15_000
  for (;;) {
    const probe = await box.exec('python3', [
      '-c',
      `import socket; socket.create_connection(('127.0.0.1', ${port}), 1).close()`,
    ])
    if (probe.exitCode === 0) break
    assert(Date.now() < deadline, 'guest service did not bind its port')
    await delay(100)
  }
  return result.stdout.trim()
}

async function ready(box: SimpleBox, port: number, marker: string): Promise<Buffer> {
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      const response = await request(box, port)
      assert(response.includes(marker), 'wrong guest response')
      return response
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await delay(250)
    }
  }
}

async function main(): Promise<void> {
  const scenario = env('BOXLITE_E2E_TUNNEL_CASE', 'transport')
  assert(['transport', 'stopped', 'half-close', 'tls-shutdown', 'private', 'network'].includes(scenario))
  const runtime = JsBoxlite.rest(
    new BoxliteRestOptions({
      url: env('BOXLITE_E2E_URL', 'http://localhost:3001/api'),
      credential: new ApiKeyCredential(env('BOXLITE_E2E_API_KEY', 'devkey')),
      pathPrefix: env('BOXLITE_E2E_PREFIX', ''),
    }),
  )
  // SimpleBox does not expose REST lifetime/autoResume options. Set them at
  // its runtime boundary so stopped tests cannot silently wake their box.
  const bounded = (options: Parameters<typeof runtime.create>[0]) => ({
    ...options,
    autoResume: false,
    autoStop: 300,
    autoDelete: 600,
  })
  const trackedRuntime = {
    create: (options: Parameters<typeof runtime.create>[0], name?: string | null) =>
      runtime.create(bounded(options), name ?? `e2e-node-${randomUUID()}`),
    getOrCreate: (options: Parameters<typeof runtime.create>[0], name?: string | null) =>
      runtime.getOrCreate(bounded(options), name ?? `e2e-node-${randomUUID()}`),
  }
  const create = () =>
    new SimpleBox({
      image: env('BOXLITE_E2E_IMAGE', DEFAULT_BOX_IMAGE),
      autoRemove: false,
      network: { inbound: { mode: 'enabled' } },
      runtime: trackedRuntime,
    })
  const boxes: SimpleBox[] = []
  const box = create()
  boxes.push(box)
  try {
    await box.exec('true')
    const { port, marker } = SERVICES[0]
    const pid = await startService(box, port, marker)
    const address = new SocketAddress({ port })
    if (scenario === 'private') {
      const tunnel = await box.network.tunnel(address, { isPublic: false })
      assert.equal(tunnel.isPublic(), false)
      assert(tunnel.token(), 'private prepare must return a token')
      const unopened = await box.network.tunnel(address, { isPublic: false })
      const socket = await tunnel.connect()
      try {
        await socket.write(GET)
        assert((await readHttp(socket)).includes(marker))
      } finally {
        await socket.close()
      }
      await box.network.revokeTunnel(port)
      // Reuse the descriptor: preparing here would undo the revoke.
      await assert.rejects(() => unopened.connect(), /404|not found/i)
    } else {
      await ready(box, port, marker)
      const tunnel = await box.network.tunnel(address)
      if (scenario === 'network') {
        const allowed = env('BOXLITE_E2E_EGRESS_ALLOWED_URL', 'https://httpbingo.org/')
        const denied = env('BOXLITE_E2E_EGRESS_UNLISTED_URL', 'https://example.com/')
        assert.notEqual(new URL(allowed).hostname, new URL(denied).hostname)
        const reaches = async (url: string) => {
          const result = await box.exec('python3', ['-c', EGRESS, url])
          assert.equal(result.exitCode, 0, 'Node egress probe process failed')
          const record = JSON.parse(result.stdout)
          assert.equal(record.probe, 'boxlite-egress-v1')
          assert.equal(typeof record.reachable, 'boolean')
          return record.reachable
        }
        assert((await reaches(allowed)) && (await reaches(denied)), 'Node egress control failed')
        await box.network.updateOutbound({ mode: 'enabled', allowNet: [new URL(allowed).hostname] })
        assert.deepEqual((await box.info()).network?.outbound, {
          mode: 'enabled',
          allowNet: [new URL(allowed).hostname],
        })
        assert(await reaches(allowed))
        assert.equal(await reaches(denied), false)
        await box.network.updateOutbound({ mode: 'enabled' })
        assert(await reaches(denied))
      } else if (scenario === 'stopped') {
        assert.equal((await box.info()).autoResume, false)
        await box.stop()
        const deadline = Date.now() + 30_000
        while ((await runtime.getInfo(box.id))?.state.status !== 'stopped') {
          assert(Date.now() < deadline, 'box never stopped')
          await delay(200)
        }
        await assert.rejects(() => box.network.tunnel(address), /not running/i)
        await assert.rejects(() => tunnel.connect(), /box is stopped and auto-resume is disabled/i)
        assert.equal((await runtime.getInfo(box.id))?.state.status, 'stopped')
      } else if (scenario === 'tls-shutdown' || scenario === 'half-close') {
        const socket = await tunnel.connect()
        try {
          await socket.write(GET)
          if (scenario === 'half-close') await socket.shutdownWrite()
          let response: Buffer
          try {
            response = await readHttp(socket)
          } catch (error) {
            if (
              scenario === 'half-close' &&
              /closed before the complete HTTP response|without sending TLS close_notify/.test(String(error))
            ) {
              throw new Error('KNOWN_HALF_CLOSE_RESPONSE_LOST')
            }
            throw error
          }
          assert(response.includes(marker), 'guest response missing')
          if (scenario === 'tls-shutdown') {
            try {
              assert.equal((await read(socket, 1)).length, 0)
            } catch (error) {
              if (/without sending TLS close_notify/.test(String(error))) throw new Error('KNOWN_TLS_SHUTDOWN_EOF')
              throw error
            }
          }
        } finally {
          await socket.close()
        }
      } else {
        await startService(box, SERVICES[1].port, SERVICES[1].marker)
        const responses = await Promise.all(
          SERVICES.flatMap((service) => Array.from({ length: 3 }, () => ready(box, service.port, service.marker))),
        )
        responses.forEach((response, index) => {
          assert(!response.includes(SERVICES[1 - Math.floor(index / 3)].marker), 'cross-port routing leak')
        })
        const socket = await tunnel.connect()
        try {
          await websocketEcho(socket, marker)
        } finally {
          await socket.close()
        }
        const body = Buffer.alloc(256 * 1024, 'n')
        const post = await request(
          box,
          port,
          Buffer.concat([
            Buffer.from(`POST / HTTP/1.0\r\nHost: tunnel.test\r\nContent-Length: ${body.length}\r\n\r\n`),
            body,
          ]),
        )
        assert(post.includes(createHash('sha256').update(body).digest('hex')), 'POST digest mismatch')
        for (const path of ['large', 'slow']) {
          const response = await request(
            box,
            port,
            Buffer.from(`GET /${path} HTTP/1.0\r\nHost: tunnel.test\r\n\r\n`),
            path === 'slow' ? 1000 : 0,
          )
          assert(response.length > 2 * 1024 * 1024, 'large response was truncated')
        }
        const cancelled = await (await box.network.tunnel(address)).connect()
        await cancelled.close()
        await Promise.all(Array.from({ length: 16 }, () => ready(box, port, marker)))
        assert.equal((await box.exec('kill', [pid])).exitCode, 0)
        await startService(box, port, marker)
        await ready(box, port, marker)
        const other = create()
        boxes.push(other)
        await other.exec('true')
        await startService(other, port, 'node-other-box')
        assert(!(await ready(other, port, 'node-other-box')).includes(marker), 'cross-box routing leak')
        assert(!(await ready(box, port, marker)).includes('node-other-box'), 'cross-box routing leak')
      }
    }
    console.log(`TUNNEL_CASE=${scenario}:ok`)
  } finally {
    try {
      // All removals run even if one fails; a cleanup error still fails the case.
      const results = await Promise.allSettled(
        boxes.map(async (created) => {
          if (created.id) await runtime.remove(created.id, true)
        }),
      )
      for (const result of results) if (result.status === 'rejected') throw result.reason
    } finally {
      runtime.close()
    }
  }
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
