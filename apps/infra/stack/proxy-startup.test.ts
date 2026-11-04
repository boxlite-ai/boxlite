// Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { buildEdge } from './edge.js'

test('the retained SST deployment supplies the proxy namespace', (t) => {
  const globals = globalThis as Record<string, any>
  const previous = { sst: globals.sst, interpolate: globals.$interpolate }
  let environment: Record<string, string> = {}
  globals.sst = {
    aws: {
      Service: class {
        constructor(_name: string, args: { environment: Record<string, string> }) {
          environment = args.environment
        }
      },
    },
  }
  globals.$interpolate = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((result, part, index) => result + part + (values[index] ?? ''), '')
  t.after(() => {
    globals.sst = previous.sst
    globals.$interpolate = previous.interpolate
  })
  buildEdge({
    foundation: { cluster: {} },
    api: { url: 'https://api.example.test' },
    router: { route() {} },
    proxyDomain: 'proxy.example.test',
    proxyProtocol: 'http',
    cloudflareDns: {},
    proxyApiKey: { result: 'test-key' },
    oidcClientId: { value: 'test' },
    oidcIssuer: 'https://issuer.example.test',
    publicOidcIssuer: undefined,
    otelCollectorOtlpHttpUrl: 'http://collector:4318',
    stripTrailingSlash: (url: string) => url,
  } as never)
  assert.equal(environment.PROXY_DOMAIN, 'proxy.example.test')
})

test('native local proxy configuration uses the same hostname namespace as API tunnel URLs', (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'boxlite-proxy-startup-'))
  t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }))
  const modulePath = fileURLToPath(new URL('../../infra-local', import.meta.url))
  // Import the real configuration builder without starting processes or a Box runtime.
  const output = execFileSync(
    'python3',
    [
      '-c',
      `
import json, sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from compose.native import _components, _Paths
proxy = _components(_Paths(Path(sys.argv[2])))['proxy']
print(json.dumps({'domain': proxy.env.get('PROXY_DOMAIN')}))
`,
      modulePath,
      fixtureRoot,
    ],
    { encoding: 'utf8' },
  )
  const { domain } = JSON.parse(output)
  assert.equal(typeof domain, 'string')
  const apiEnv = readFileSync(new URL('../../infra-local/api.env', import.meta.url), 'utf8')
  const apiDomain = apiEnv.match(/^PROXY_DOMAIN=(.+)$/m)![1]
  assert.equal(new URL(`http://${domain}`).hostname, new URL(`http://${apiDomain}`).hostname)
})
