/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Request } from 'express'
import { requestActor } from './user-context.decorator'

function request(user: unknown, headers: Record<string, string> = {}): Request {
  const sent = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]))
  return { user, get: (name: string) => sent.get(name.toLowerCase()) } as unknown as Request
}

const person = { userId: 'user-1', role: 'user', email: 'user@boxlite.dev' }

describe('requestActor', () => {
  it('names an API key caller and the client labels it sent', () => {
    const actor = requestActor(
      request(
        { ...person, apiKey: { name: 'ci' }, organizationId: 'org-1' },
        { 'X-BoxLite-Source': 'sdk-python', 'X-BoxLite-SDK-Version': '0.9.0' },
      ),
    )

    expect(actor).toEqual({ userId: 'user-1', authMethod: 'api_key', clientSource: 'sdk-python', sdkVersion: '0.9.0' })
  })

  it('names a session caller as jwt, without labels it did not send', () => {
    expect(requestActor(request(person))).toEqual({
      userId: 'user-1',
      authMethod: 'jwt',
      clientSource: undefined,
      sdkVersion: undefined,
    })
  })

  // The labels are logged as sent, so anything but a short plain token is dropped.
  it('drops a client label that is not a short plain token', () => {
    const actor = requestActor(
      request(person, { 'X-BoxLite-Source': 'sdk\nforged=1', 'X-BoxLite-SDK-Version': '1'.repeat(65) }),
    )

    expect(actor?.clientSource).toBeUndefined()
    expect(actor?.sdkVersion).toBeUndefined()
  })

  it('names no one for a service caller or an unauthenticated request', () => {
    expect(requestActor(request({ role: 'proxy' }))).toBeUndefined()
    expect(requestActor(request(undefined))).toBeUndefined()
  })
})
