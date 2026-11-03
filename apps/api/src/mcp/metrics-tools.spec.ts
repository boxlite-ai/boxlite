/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { McpMetricsTools } from './metrics-tools'
import { runnerHarness, caller, ORGANIZATION_ID, FOREIGN_ORGANIZATION_ID } from './tests/runner-harness'

describe('McpMetricsTools HTTP observation', () => {
  let harness: Awaited<ReturnType<typeof runnerHarness>>
  let fixture: ReturnType<typeof harness.reset>
  const scope = { organization_id: ORGANIZATION_ID, box_id: 'my box' }
  const metrics = {
    commands_executed_total: 0,
    exec_errors_total: 0,
    bytes_sent_total: 5,
    bytes_received_total: 7,
    cpu_percent: 0,
    memory_bytes: 1024,
  }
  beforeAll(async () => {
    harness = await runnerHarness((server, access, runner) =>
      new McpMetricsTools(access, runner).register(server, caller),
    )
  })
  afterAll(async () => harness.close())
  beforeEach(() => {
    fixture = harness.reset()
    harness.respond((response) => response.end(JSON.stringify(metrics)))
  })

  it('advertises observation-only metrics without runtime-wide or invented timing tools', async () => {
    const body = await harness.list()
    expect(body.result.tools.map((tool) => tool.name)).toEqual(['get_box_metrics'])
    expect(body.result.tools[0].annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    })
    const fields = body.result.tools[0].outputSchema.properties
    expect(fields).not.toHaveProperty('create_duration_ms')
    expect(fields).not.toHaveProperty('boot_timing')
  })

  it('projects current OpenAPI fields and preserves numeric zero without activity or auto-resume', async () => {
    fixture.box.autoResume = true
    fixture.box.autoStop = 1
    fixture.member.assignedRoles = []
    harness.respond((response) =>
      response.end(
        JSON.stringify({
          ...metrics,
          network_bytes_sent: 0,
          network_tcp_errors: 0,
          create_duration_ms: 10,
          boot_duration_ms: 4,
          secret: 'not-public',
        }),
      ),
    )
    const body = await harness.call('get_box_metrics', scope)
    expect(body.result.structuredContent).toEqual({ ...metrics, network_bytes_sent: 0, network_tcp_errors: 0 })
    expect(JSON.parse(body.result.content[0].text)).toEqual(body.result.structuredContent)
    expect(harness.requests[0]).toMatchObject({
      method: 'GET',
      url: '/v1/boxes/internal-box/metrics',
      authorization: 'Bearer runner-secret',
    })
    expect(fixture.boxes.updateLastActivityAt).not.toHaveBeenCalled()
    expect(fixture.resume.ensureReady).not.toHaveBeenCalled()
  })

  it('denies non-members and foreign Boxes before Runner requests', async () => {
    fixture.memberships.findOne.mockResolvedValueOnce(null)
    expect(
      (await harness.call('get_box_metrics', { ...scope, organization_id: FOREIGN_ORGANIZATION_ID })).result.isError,
    ).toBe(true)
    fixture.box.organizationId = FOREIGN_ORGANIZATION_ID
    expect((await harness.call('get_box_metrics', scope)).result.isError).toBe(true)
    expect(harness.requests).toHaveLength(0)
  })

  it.each(['not-json runner-secret', JSON.stringify({ ...metrics, memory_bytes: -1 }), '{}'])(
    'rejects malformed or invalid metric responses with sanitized errors',
    async (payload) => {
      harness.respond((response) => response.end(payload))
      const body = await harness.call('get_box_metrics', scope)
      expect(body.result.isError).toBe(true)
      expect(body.result.content[0].text).toBe('Invalid Runner metrics response')
      expect(body.result).not.toHaveProperty('structuredContent')
      expect(JSON.stringify(body)).not.toContain('runner-secret')
    },
  )

  it('rejects unsupported metric arguments before access', async () => {
    const body = await harness.call('get_box_metrics', { ...scope, resume: true })
    expect(body.error ?? body.result.isError).toBeTruthy()
    expect(fixture.memberships.findOne).not.toHaveBeenCalled()
    expect(harness.requests).toHaveLength(0)
  })
})
