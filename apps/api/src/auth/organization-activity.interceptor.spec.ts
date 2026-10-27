/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CallHandler, ExecutionContext, Logger } from '@nestjs/common'
import { Redis } from 'ioredis'
import { lastValueFrom, of } from 'rxjs'
import { OrganizationActivityInterceptor } from './organization-activity.interceptor'
import { recordBusinessEvent } from '../common/utils/business-event.util'
import { Context } from '../common/context/context'

jest.mock('../common/utils/business-event.util', () => ({ recordBusinessEvent: jest.fn() }))

// What OrganizationAccessGuard leaves on the request once it has verified the membership.
const member = {
  userId: 'user-1',
  role: 'user',
  email: 'user@boxlite.dev',
  organizationId: 'org-1',
  organization: { id: 'org-1' },
  organizationUser: { organizationId: 'org-1', userId: 'user-1' },
}

function httpContext(user: unknown): ExecutionContext {
  const request = { user, get: () => undefined }
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext
}

/** Runs one request through the interceptor and waits for its detached recording. */
async function intercept(user: unknown, set: jest.Mock): Promise<unknown> {
  const interceptor = new OrganizationActivityInterceptor({ set } as unknown as Redis)
  const handler: CallHandler = { handle: () => of('response') }
  const response = await lastValueFrom(interceptor.intercept(httpContext(user), handler))
  await new Promise((resolve) => setImmediate(resolve))
  return response
}

describe('OrganizationActivityInterceptor', () => {
  beforeEach(() => {
    jest.mocked(recordBusinessEvent).mockClear()
    jest.useFakeTimers({ doNotFake: ['setImmediate'] }).setSystemTime(new Date('2026-10-23T23:30:00.000Z'))
  })

  afterEach(() => {
    jest.useRealTimers()
    jest.restoreAllMocks()
  })

  it('records org.active for the first request of a person in an organization in a UTC hour', async () => {
    const set = jest.fn().mockResolvedValue('OK')

    await expect(intercept(member, set)).resolves.toBe('response')

    expect(set).toHaveBeenCalledWith('business-event:org-active:org-1:user-1:2026-10-23T23', '1', 'EX', 7200, 'NX')
    expect(recordBusinessEvent).toHaveBeenCalledWith({
      name: 'org.active',
      outcome: 'success',
      correlationId: 'user-1',
      organizationId: 'org-1',
      ctx: Context.user({ userId: 'user-1', authMethod: 'jwt', clientSource: undefined, sdkVersion: undefined }),
    })
  })

  it('records nothing for a later request the same hour', async () => {
    await intercept(member, jest.fn().mockResolvedValue(null))

    expect(recordBusinessEvent).not.toHaveBeenCalled()
  })

  // Days show in Asia/Shanghai, eight hours ahead: 02:00 and 23:30 UTC on the 23rd fall on
  // the 23rd and the 24th there, so both must record.
  it('records again in each new UTC hour, so the person shows on every Shanghai day', async () => {
    const keys = new Set<string>()
    // Honours SET ... NX: only the first write of a key succeeds.
    const set = jest.fn(async (key: string) => {
      if (keys.has(key)) return null
      keys.add(key)
      return 'OK'
    })

    for (const at of ['2026-10-23T02:00:00Z', '2026-10-23T02:40:00Z', '2026-10-23T23:30:00Z', '2026-10-24T00:10:00Z']) {
      jest.setSystemTime(new Date(at))
      await intercept(member, set)
    }

    expect(recordBusinessEvent).toHaveBeenCalledTimes(3)
  })

  // Presence must never cost a request: a Redis outage drops the event, not the call.
  it('answers the request and records nothing when Redis fails', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const set = jest.fn().mockRejectedValue(new Error('connection refused'))

    await expect(intercept(member, set)).resolves.toBe('response')

    expect(recordBusinessEvent).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  // A JWT login copies X-BoxLite-Organization-ID into organizationId unchecked; only the
  // guard's membership lookup makes it an organization the person belongs to.
  it('ignores an organization the guard has not verified the person belongs to', async () => {
    const set = jest.fn().mockResolvedValue('OK')
    const signedIn = { userId: 'user-1', role: 'user', email: 'user@boxlite.dev' }

    await intercept({ ...signedIn, organizationId: undefined }, set)
    await intercept({ ...signedIn, organizationId: 'org-2' }, set)
    await intercept({ ...signedIn, role: 'admin', organizationId: 'org-2', organization: { id: 'org-2' } }, set)

    expect(set).not.toHaveBeenCalled()
    expect(recordBusinessEvent).not.toHaveBeenCalled()
  })

  it('ignores requests outside an organization and requests by services', async () => {
    const set = jest.fn().mockResolvedValue('OK')

    await intercept({ userId: 'user-1', role: 'user', email: 'user@boxlite.dev' }, set)
    await intercept({ role: 'proxy', organizationId: 'org-1' }, set)
    await intercept(undefined, set)

    expect(set).not.toHaveBeenCalled()
    expect(recordBusinessEvent).not.toHaveBeenCalled()
  })
})
