/// <reference path="./tracing.spec.d.ts" />
/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
// Inspect the actual instrumentation configuration without starting exporters.
jest.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: jest.fn().mockImplementation((options) => ({ options, shutdown: jest.fn() })),
}))
import { defaultDbStatementSerializer } from '@opentelemetry/redis-common'
import { otelSdk } from './tracing'

const configured = (name: string) => {
  const { options } = otelSdk as unknown as {
    options: { instrumentations: Array<{ instrumentationName: string; getConfig: () => any }> }
  }
  return options.instrumentations.find((item) => item.instrumentationName === name)?.getConfig()
}

describe('MCP telemetry boundaries', () => {
  it('excludes initial consent URLs from HTTP spans while retaining ordinary API tracing', () => {
    const config = configured('@opentelemetry/instrumentation-http')
    expect(
      config.ignoreIncomingRequestHook?.({ url: '/mcp/consent?challenge=private-token&state=private-state' }) ?? false,
    ).toBe(true)
    expect(config.ignoreIncomingRequestHook?.({ url: '/api/boxes' }) ?? false).toBe(false)
  })
  it('omits Lua arguments carrying command output from Redis spans', () => {
    const config = configured('@opentelemetry/instrumentation-ioredis')
    const serialize = config.dbStatementSerializer ?? defaultDbStatementSerializer
    const statement = serialize('eval', ['script', '3', 'mcp:output:{org}:op:meta', 'private-command-output'])
    expect(statement).not.toContain('private-command-output')
    expect(serialize('get', ['ordinary-cache-key'])).toContain('ordinary-cache-key')
  })
})
