/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxliteConfigController } from '../../../boxlite-rest/boxlite-config.controller'
import { registerConfigTool } from './config-tool'
import { toolHarness } from '../../tests/tool-harness'

describe('MCP hosted capability tool', () => {
  let harness: Awaited<ReturnType<typeof toolHarness>>
  beforeEach(async () => {
    harness = await toolHarness(registerConfigTool)
  })
  afterEach(async () => {
    await harness.close()
  })

  it('advertises one strict pure read with no organization arguments', async () => {
    const { result } = await harness.list()
    expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual(['get_config'])
    expect(result.tools[0].inputSchema).toEqual(
      expect.objectContaining({ type: 'object', properties: {}, additionalProperties: false }),
    )
    expect(result.tools[0].annotations).toEqual(
      expect.objectContaining({ readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
    )
    expect(result.tools[0].outputSchema.properties.capabilities.additionalProperties).toBe(false)
  })
  it('shares exact public REST capability values in structured and legacy text results', async () => {
    const { result } = await harness.call('get_config', {})
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual(new BoxliteConfigController().getConfig())
    expect(result.structuredContent.capabilities).toEqual({
      snapshots_enabled: false,
      clone_enabled: false,
      export_enabled: false,
      import_enabled: false,
      inbound_update_enabled: true,
    })
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent)
  })
  it('rejects unknown options instead of accepting organization or deployment config selectors', async () => {
    for (const request of [{ organization_id: '11111111-1111-4111-8111-111111111111' }, { include_secrets: true }]) {
      const body = await harness.call('get_config', request)
      expect(body.error || body.result?.isError).toBeTruthy()
    }
  })
})
