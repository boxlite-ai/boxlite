/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { AuthContext } from '../../../common/interfaces/auth-context.interface'
import { OrganizationService } from '../../../organization/services/organization.service'
import { caller, FOREIGN_ORGANIZATION_ID, ORGANIZATION_ID, toolHarness } from '../../tests/tool-harness'
import { OrganizationTools } from './organization-tools'

describe('MCP organization discovery', () => {
  const findByUserWithDefaultFlag = jest.fn()
  const tools = new OrganizationTools({ findByUserWithDefaultFlag } as unknown as OrganizationService)
  const memberships = [
    { organization: { id: ORGANIZATION_ID, name: 'Primary' }, isDefaultForAuthenticatedUser: true },
    { organization: { id: FOREIGN_ORGANIZATION_ID, name: 'Research' }, isDefaultForAuthenticatedUser: false },
  ]

  async function withCaller(auth: AuthContext) {
    return toolHarness((server) => tools.register(server, auth))
  }

  beforeEach(() => {
    findByUserWithDefaultFlag.mockReset().mockResolvedValue(memberships)
  })

  it('advertises a strict, read-only tool without organization input', async () => {
    const harness = await withCaller(caller)
    try {
      const { result } = await harness.list()
      expect(result.tools.map((tool: { name: string }) => tool.name)).toEqual(['list_organizations'])
      expect(result.tools[0].inputSchema).toEqual(
        expect.objectContaining({ type: 'object', properties: {}, additionalProperties: false }),
      )
      expect(result.tools[0].annotations).toEqual(
        expect.objectContaining({ readOnlyHint: true, destructiveHint: false, openWorldHint: false }),
      )
    } finally {
      await harness.close()
    }
  })

  it('returns only member organization identifiers, names, and default status', async () => {
    const harness = await withCaller(caller)
    try {
      const { result } = await harness.call('list_organizations', {})
      expect(result.isError).toBeFalsy()
      expect(findByUserWithDefaultFlag).toHaveBeenCalledWith(caller.userId)
      expect(result.structuredContent).toEqual([
        { id: ORGANIZATION_ID, name: 'Primary', is_default: true },
        { id: FOREIGN_ORGANIZATION_ID, name: 'Research', is_default: false },
      ])
      expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent)
    } finally {
      await harness.close()
    }
  })

  it('limits an API-key caller to its own organization', async () => {
    const auth = { ...caller, apiKey: { organizationId: FOREIGN_ORGANIZATION_ID } } as AuthContext
    const harness = await withCaller(auth)
    try {
      const { result } = await harness.call('list_organizations', {})
      expect(result.structuredContent).toEqual([{ id: FOREIGN_ORGANIZATION_ID, name: 'Research', is_default: false }])
    } finally {
      await harness.close()
    }
  })

  it('returns an empty list when the caller has no memberships', async () => {
    findByUserWithDefaultFlag.mockResolvedValue([])
    const harness = await withCaller(caller)
    try {
      const { result } = await harness.call('list_organizations', {})
      expect(result.structuredContent).toEqual([])
    } finally {
      await harness.close()
    }
  })

  it('rejects arguments that could bypass caller-scoped listing', async () => {
    const harness = await withCaller(caller)
    try {
      const body = await harness.call('list_organizations', { organization_id: FOREIGN_ORGANIZATION_ID })
      expect(body.error || body.result?.isError).toBeTruthy()
      expect(findByUserWithDefaultFlag).not.toHaveBeenCalled()
    } finally {
      await harness.close()
    }
  })
})
