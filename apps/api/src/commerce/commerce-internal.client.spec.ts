/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

jest.mock('axios', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}))

import axios from 'axios'
import { CommerceInternalClient } from './commerce-internal.client'
import { CommerceConflictError, CommerceUnavailableError } from './commerce.errors'

const get = axios.get as jest.Mock
const post = axios.post as jest.Mock

const INVITER_ID = '0b5f4d6e-8c1a-4f7b-9e2d-3a6c8b1f0e47'

function makeClient(settings: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    billingApiUrl: 'https://commerce.test/api/billing/',
    'usageExport.token': 'shared-token',
    'usageExport.enabled': false,
    'usageExport.allocationSnapshotEnabled': false,
    'usageExport.url': undefined,
    ...settings,
  }
  const configService = { get: jest.fn((key: string) => values[key]) }
  const client = new CommerceInternalClient(configService as never)
  const logger = (
    client as unknown as { logger: { warn: (message: string) => void; error: (message: string) => void } }
  ).logger
  return {
    client,
    warn: jest.spyOn(logger, 'warn').mockImplementation(() => undefined),
    error: jest.spyOn(logger, 'error').mockImplementation(() => undefined),
  }
}

function httpFailure(status: number, data?: unknown) {
  // What axios rejects with: the request config, bearer token included, rides along.
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
    config: { headers: { authorization: 'Bearer shared-token' } },
  })
}

beforeEach(() => {
  get.mockReset()
  post.mockReset()
})

describe('CommerceInternalClient', () => {
  describe('isConfigured', () => {
    it('is true with BILLING_API_URL and the shared token', () => {
      expect(makeClient().client.isConfigured()).toBe(true)
    })

    it.each([
      ['BILLING_API_URL', { billingApiUrl: undefined }],
      ['the shared token', { 'usageExport.token': undefined }],
    ])('is false without %s', (_label, settings) => {
      expect(makeClient(settings).client.isConfigured()).toBe(false)
    })
  })

  describe('resolveReferralCode', () => {
    it("looks the normalized code up on Commerce's bare origin with the service token", async () => {
      get.mockResolvedValueOnce({ status: 200, data: { organizationId: INVITER_ID, code: 'ABCD2345EF' } })
      const { client } = makeClient()

      await expect(client.resolveReferralCode(' abcd2345ef ')).resolves.toBe(INVITER_ID)

      expect(get).toHaveBeenCalledTimes(1)
      const [url, config] = get.mock.calls[0]
      // The internal route sits outside the /api/billing prefix BILLING_API_URL carries.
      expect(url).toBe('https://commerce.test/internal/organization')
      expect(config).toMatchObject({
        params: { 'referral-code': 'ABCD2345EF' },
        timeout: 5_000,
        headers: { authorization: 'Bearer shared-token' },
      })
      expect([200, 404].map(config.validateStatus)).toEqual([true, true])
      expect([201, 204, 301, 400, 500].map(config.validateStatus)).toEqual([false, false, false, false, false])
    })

    it.each(['usageExport.enabled', 'usageExport.allocationSnapshotEnabled'])(
      'uses USAGE_EXPORT_URL while %s is on',
      async (flag) => {
        get.mockResolvedValueOnce({ status: 200, data: { organizationId: INVITER_ID } })
        const { client } = makeClient({ [flag]: true, 'usageExport.url': 'https://commerce.internal/prefix' })

        await client.resolveReferralCode('ABCD2345EF')

        expect(get).toHaveBeenCalledWith('https://commerce.internal/prefix/internal/organization', expect.anything())
      },
    )

    it('ignores USAGE_EXPORT_URL while export is off, when configuration leaves it unvalidated', async () => {
      get.mockResolvedValueOnce({ status: 200, data: { organizationId: INVITER_ID } })
      const { client } = makeClient({ 'usageExport.url': 'placeholder' })

      await client.resolveReferralCode('ABCD2345EF')

      expect(get).toHaveBeenCalledWith('https://commerce.test/internal/organization', expect.anything())
    })

    it.each(['', 'ABCD2345E', 'ABCD2345EFG', 'ABCD2345E0', 'ABCD2345EI', 'ABCD-2345E'])(
      'returns null for %p without asking Commerce',
      async (code) => {
        const { client } = makeClient()

        await expect(client.resolveReferralCode(code)).resolves.toBeNull()
        expect(get).not.toHaveBeenCalled()
      },
    )

    it('returns null when Commerce does not know the code', async () => {
      get.mockResolvedValueOnce({ status: 404, data: { message: 'Referral code not found' } })

      await expect(makeClient().client.resolveReferralCode('ABCD2345EF')).resolves.toBeNull()
    })

    it.each([null, '<html>', {}, { organizationId: 42 }, { organizationId: 'org-a' }])(
      'fails closed when a 200 carries %p instead of an organization uuid',
      async (data) => {
        get.mockResolvedValueOnce({ status: 200, data })
        const { client, error } = makeClient()

        await expect(client.resolveReferralCode('ABCD2345EF')).rejects.toBeInstanceOf(CommerceUnavailableError)
        expect(error).toHaveBeenCalledTimes(1)
      },
    )

    it.each([400, 401, 403, 429, 500, 503])(
      'reports Commerce HTTP %i as unavailable without leaking the token',
      async (status) => {
        get.mockRejectedValueOnce(httpFailure(status))
        const { client, warn, error } = makeClient()

        const caught = await client.resolveReferralCode('ABCD2345EF').catch((rejection) => rejection)

        expect(caught).toBeInstanceOf(CommerceUnavailableError)
        expect(caught.message).toContain(`HTTP ${status}`)
        expect(caught.cause).toBeUndefined()
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(`HTTP ${status}`))
        expect(JSON.stringify([caught.message, ...warn.mock.calls, ...error.mock.calls])).not.toContain('shared-token')
      },
    )

    it('reports a timeout as unavailable', async () => {
      get.mockRejectedValueOnce(Object.assign(new Error('timeout of 5000ms exceeded'), { code: 'ECONNABORTED' }))
      const { client, warn } = makeClient()

      await expect(client.resolveReferralCode('ABCD2345EF')).rejects.toBeInstanceOf(CommerceUnavailableError)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ECONNABORTED'))
    })

    it('refuses to run while Commerce is not configured', async () => {
      const { client } = makeClient({ billingApiUrl: undefined })

      await expect(client.resolveReferralCode('ABCD2345EF')).rejects.toBeInstanceOf(CommerceUnavailableError)
      expect(get).not.toHaveBeenCalled()
    })
  })

  describe('acceptsInviteeEmail', () => {
    it.each([
      ['an address', 'invitee@example.com', true],
      ['254 characters', `${'a'.repeat(242)}@example.com`, true],
      ['255 characters', `${'a'.repeat(243)}@example.com`, false],
      ['an empty string', '', false],
      ['no value', undefined, false],
      ['no @', 'invitee.example.com', false],
      ['a C0 control character', 'invitee@example.com\n', false],
      ['a C1 control character', 'invitee\u0085@example.com', false],
    ])('follows Commerce for %s', (_label, email, accepted) => {
      expect(makeClient().client.acceptsInviteeEmail(email)).toBe(accepted)
    })
  })

  describe('publishReferralNewer', () => {
    const INVITEE = {
      id: 'google-oauth2|1234',
      email: 'invitee@example.com',
      createdAt: new Date('2026-10-02T10:34:13.123Z'),
    }

    it('posts the referral-newer event for the inviter on the bare origin with the service token', async () => {
      post.mockResolvedValueOnce({ status: 202, data: { status: 'pending' } })

      await expect(makeClient().client.publishReferralNewer(INVITER_ID, INVITEE)).resolves.toBeUndefined()

      expect(post).toHaveBeenCalledTimes(1)
      const [url, body, config] = post.mock.calls[0]
      expect(url).toBe(`https://commerce.test/internal/organization/${INVITER_ID}/billing-events`)
      // Commerce accepts exactly these fields. The eventId is pinned: another
      // value for the same account would turn a retry into a new delivery.
      expect(body).toEqual({
        eventId: '433114d1-a44d-526b-bd6e-f4be7dabc8db',
        type: 'referral-newer',
        occurredAt: '2026-10-02T10:34:13.123Z',
        data: { inviteeUserId: 'google-oauth2|1234', inviteeEmail: 'invitee@example.com' },
      })
      expect(config).toMatchObject({ timeout: 5_000, headers: { authorization: 'Bearer shared-token' } })
      expect([200, 202, 204, 409].map(config.validateStatus)).toEqual([true, true, true, true])
      expect([301, 400, 404, 500].map(config.validateStatus)).toEqual([false, false, false, false])
    })

    it('derives one eventId per account, in the format Commerce accepts', async () => {
      post.mockResolvedValue({ status: 202 })
      const { client } = makeClient()

      await client.publishReferralNewer(INVITER_ID, INVITEE)
      // A retry after a rollback inserts the account again, with a later createdAt.
      await client.publishReferralNewer(INVITER_ID, { ...INVITEE, createdAt: new Date('2026-10-02T10:35:00.000Z') })
      await client.publishReferralNewer(INVITER_ID, { ...INVITEE, id: 'google-oauth2|5678' })

      const [first, retry, other] = post.mock.calls.map(([, body]) => body.eventId)
      expect(retry).toBe(first)
      expect(other).not.toBe(first)
      expect(other).toMatch(/^[A-Za-z0-9_-]{1,200}$/)
    })

    it.each([200, 202])('treats HTTP %i as accepted without reading the body', async (status) => {
      post.mockResolvedValueOnce({ status, data: '<html>' })

      await expect(makeClient().client.publishReferralNewer(INVITER_ID, INVITEE)).resolves.toBeUndefined()
    })

    it('reports a 409 as another organization owning the referral', async () => {
      post.mockResolvedValueOnce({ status: 409, data: { message: 'Conflict' } })

      await expect(makeClient().client.publishReferralNewer(INVITER_ID, INVITEE)).rejects.toBeInstanceOf(
        CommerceConflictError,
      )
    })

    it.each([400, 413, 422])(
      'logs HTTP %i once as a malformed event and reports Commerce unavailable',
      async (status) => {
        post.mockRejectedValueOnce(httpFailure(status, { message: 'inviteeEmail must contain 1 to 254 characters' }))
        const { client, warn, error } = makeClient()

        const caught = await client.publishReferralNewer(INVITER_ID, INVITEE).catch((rejection) => rejection)

        expect(caught).toBeInstanceOf(CommerceUnavailableError)
        expect(error).toHaveBeenCalledTimes(1)
        expect(error).toHaveBeenCalledWith(expect.stringContaining(`(HTTP ${status}): inviteeEmail must contain`))
        expect(warn).not.toHaveBeenCalled()
        expect(JSON.stringify([caught.message, ...error.mock.calls])).not.toContain('shared-token')
      },
    )

    it.each([
      ['HTTP 401', httpFailure(401)],
      ['HTTP 404', httpFailure(404)],
      ['HTTP 500', httpFailure(500)],
      ['HTTP 503', httpFailure(503)],
      ['ECONNREFUSED', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
      ['ECONNABORTED', Object.assign(new Error('timeout of 5000ms exceeded'), { code: 'ECONNABORTED' })],
    ])('reports %s as Commerce unavailable without leaking the token', async (reason, failure) => {
      post.mockRejectedValueOnce(failure)
      const { client, warn, error } = makeClient()

      const caught = await client.publishReferralNewer(INVITER_ID, INVITEE).catch((rejection) => rejection)

      expect(caught).toBeInstanceOf(CommerceUnavailableError)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(reason))
      expect(error).not.toHaveBeenCalled()
      expect(JSON.stringify([caught.message, ...warn.mock.calls])).not.toContain('shared-token')
    })

    it('refuses to run while Commerce is not configured', async () => {
      const { client } = makeClient({ 'usageExport.token': undefined })

      await expect(client.publishReferralNewer(INVITER_ID, INVITEE)).rejects.toBeInstanceOf(CommerceUnavailableError)
      expect(post).not.toHaveBeenCalled()
    })
  })
})
