/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { McpServer } from '@modelcontextprotocol/server'
import type { BoxService } from '../../box/services/box.service'
import type { RunnerService } from '../../box/services/runner.service'
import type { BoxAutoResumeService } from '../../box/services/box-auto-resume.service'
import { McpRunnerHttp } from '../runner-http'
import type { McpToolAccess } from '../mcp-tool-access'
import { accessFixture, ORGANIZATION_ID, toolHarness } from './tool-harness'

/** Two real HTTP boundaries: SDK tool calls and the production adapter's Runner requests. */
export async function runnerHarness(
  register: (server: McpServer, access: McpToolAccess, runner: McpRunnerHttp) => void,
) {
  const requests: { method: string; url: string; authorization: string; body: Buffer }[] = []
  let respond: (response: ServerResponse, body: Buffer) => void
  let fixture: ReturnType<typeof accessFixture>
  let runner: McpRunnerHttp
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks)
    requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization, body })
    respond(response, body)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  function reset() {
    requests.length = 0
    fixture = accessFixture()
    const box = {
      id: 'internal-box',
      organizationId: ORGANIZATION_ID,
      runnerId: 'runner-1',
      autoResume: false,
      autoStop: 0,
    }
    fixture.boxes.findOneByIdOrName.mockResolvedValue(box)
    const boxes = { ...fixture.boxes, updateLastActivityAt: jest.fn().mockResolvedValue(undefined) }
    const resume = { ensureReady: jest.fn().mockResolvedValue(undefined) }
    runner = new McpRunnerHttp(
      boxes as unknown as BoxService,
      { findOne: jest.fn().mockResolvedValue({ apiUrl: origin, apiKey: 'runner-secret' }) } as unknown as RunnerService,
      resume as unknown as BoxAutoResumeService,
    )
    respond = (response) => response.end('{}')
    return { ...fixture, box, boxes, resume }
  }
  reset()
  const mcp = await toolHarness((mcpServer) => register(mcpServer, fixture.access, runner))
  return {
    ...mcp,
    requests,
    reset,
    respond: (handler: typeof respond) => {
      respond = handler
    },
    close: async () => {
      await mcp.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

export { caller, ORGANIZATION_ID, FOREIGN_ORGANIZATION_ID } from './tool-harness'
