/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { McpConsentController } from './mcp-consent.controller'
import { SystemRole } from '../user/enums/system-role.enum'

describe('McpConsentController request boundaries', () => {
  const consent = { preview: jest.fn(), approve: jest.fn() }
  const grants = { list: jest.fn(), revoke: jest.fn() }
  const controller = new McpConsentController(
    consent as never,
    grants as never,
    {
      get: () => 'https://app.test/mcp/consent',
    } as never,
  )
  const request = (method = 'POST', origin: string | undefined = 'https://app.test', role = SystemRole.USER) =>
    ({ method, get: () => origin, user: { userId: 'signed-in-user', role } }) as never
  const approval = {
    challenge: 'signed-challenge',
    state: 'auth0-state',
    organization_id: '00000000-0000-4000-8000-000000000001',
    scopes: ['boxes:read'],
  }

  beforeEach(() => jest.clearAllMocks())

  it('passes only the authenticated subject and validated approval fields to the service', () => {
    controller.approve(request(), approval)
    expect(consent.approve).toHaveBeenCalledWith(
      'signed-in-user',
      approval.challenge,
      approval.state,
      approval.organization_id,
      approval.scopes,
    )
    expect(() => controller.approve(request(), { ...approval, user_id: 'other-user' })).toThrow(
      'Invalid consent request',
    )
    expect(() => controller.approve(request(), { ...approval, scopes: ['admin'] })).toThrow('Invalid consent request')
    expect(consent.approve).toHaveBeenCalledTimes(1)
  })

  it('rejects missing or foreign origins before granting or revoking access', () => {
    for (const origin of ['', 'https://attacker.test']) {
      expect(() => controller.approve(request('POST', origin), approval)).toThrow('Invalid consent origin')
      expect(() => controller.revoke(request('DELETE', origin), approval.organization_id)).toThrow(
        'Invalid consent origin',
      )
    }
    expect(consent.approve).not.toHaveBeenCalled()
    expect(grants.revoke).not.toHaveBeenCalled()
  })

  it('limits preview and grant management to signed-in users and their own grants', () => {
    expect(() =>
      controller.preview(request('POST', 'https://app.test', SystemRole.ADMIN), { challenge: 'token' }),
    ).toThrow('User sign-in required')
    controller.list(request('GET', ''))
    controller.revoke(request('DELETE'), approval.organization_id)
    expect(grants.list).toHaveBeenCalledWith('signed-in-user')
    expect(grants.revoke).toHaveBeenCalledWith('signed-in-user', approval.organization_id)
    expect(consent.preview).not.toHaveBeenCalled()
  })
})
