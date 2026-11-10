import { ExecutionContext, UnauthorizedException, ValidationPipe } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { firstValueFrom, defer } from 'rxjs'
import { SignJWT } from 'jose'
import { AuditInterceptor } from './interceptors/audit.interceptor'
import { BoxController } from '../box/controllers/box.controller'
import { AttachTicketService } from '../box/services/attach-ticket.service'
import { CreateAttachTicketDto } from '../box/dto/attach-ticket.dto'
import { OrganizationController } from '../organization/controllers/organization.controller'
import { AccountLinkService, ADOPT_AUDIENCE } from '../auth/account-link.service'
import { UserController } from '../user/user.controller'
import axios from 'axios'
import { EventEmitter } from 'node:events'
import { Box } from '../box/entities/box.entity'
import { BoxState } from '../box/enums/box-state.enum'
import { BOX_EVENT_CHANNEL } from '../common/constants/constants'

const user = {
  userId: 'user',
  email: 'user@example.test',
  organizationId: 'org',
  apiKey: { keyHash: 'private-key-hash' },
}
function auditCall(handler: (...args: any[]) => unknown, request: any, invoke: () => Promise<unknown>) {
  const audit = { createLog: jest.fn().mockResolvedValue({ id: 'audit' }), updateLog: jest.fn().mockResolvedValue({}) }
  const context = {
    getHandler: () => handler,
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({ statusCode: 200 }) }),
  } as unknown as ExecutionContext
  const interceptor = new (AuditInterceptor as any)(new Reflector(), audit, { get: () => false }) as AuditInterceptor
  return { audit, result: firstValueFrom(interceptor.intercept(context, { handle: () => defer(invoke) })) }
}

it('audits real attach ticket issuance without leaking its ticket or key hash', async () => {
  const stored = new Map<string, string>()
  const tickets = new AttachTicketService({
    set: async (key: string, value: string) => stored.set(key, value),
    getdel: async (key: string) => {
      const value = stored.get(key)
      stored.delete(key)
      return value
    },
  } as never)
  const controller = new BoxController(
    {} as never,
    { findOneByIdOrName: async () => ({ id: 'box-id' }) } as never,
    { duplicate: () => ({ subscribe: () => undefined, on: () => undefined }) } as never,
    tickets,
  )
  const request = { user, body: { executionId: 'exec-id' }, params: { boxIdOrName: 'mybox' }, get: () => undefined }
  const { audit, result } = auditCall(BoxController.prototype.createAttachTicket, request, () =>
    (controller.createAttachTicket as any)(user, 'mybox', request.body, request),
  )
  const issued = (await result) as { ticket: string }
  expect(await tickets.consume(issued.ticket)).toMatchObject({
    boxId: 'box-id',
    execId: 'exec-id',
    apiKeyHash: 'private-key-hash',
  })
  expect(audit.createLog).toHaveBeenCalledWith(
    expect.objectContaining({ action: 'issue_attach_ticket', metadata: { executionId: 'exec-id' } }),
  )
  expect(audit.updateLog).toHaveBeenCalledWith('audit', expect.objectContaining({ targetId: 'box-id' }))
  expect(JSON.stringify(audit.createLog.mock.calls)).not.toContain(issued.ticket)
  expect(JSON.stringify(audit.createLog.mock.calls)).not.toContain('private-key-hash')
})

it.each([{ secret: 'private-execution-id' }, ['private-execution-id'], 123])(
  'excludes invalid execution ID %j before request validation',
  async (executionId) => {
    const request = { user, body: { executionId }, params: { boxIdOrName: 'mybox' }, get: () => undefined }
    const { audit, result } = auditCall(BoxController.prototype.createAttachTicket, request, () =>
      new ValidationPipe({ transform: true }).transform(request.body, {
        type: 'body',
        metatype: CreateAttachTicketDto,
      }),
    )
    await expect(result).rejects.toMatchObject({ status: 400 })
    expect(audit.createLog).toHaveBeenCalledWith(expect.objectContaining({ metadata: { executionId: null } }))
    expect(JSON.stringify([audit.createLog.mock.calls, audit.updateLog.mock.calls])).not.toContain(
      'private-execution-id',
    )
  },
)

it('retains the resolved box ID when attach ticket persistence fails', async () => {
  const tickets = new AttachTicketService({
    set: async () => {
      throw new Error('ticket persistence failed')
    },
  } as never)
  const controller = new BoxController(
    {} as never,
    { findOneByIdOrName: async () => ({ id: 'box-id' }) } as never,
    { duplicate: () => ({ subscribe: () => undefined, on: () => undefined }) } as never,
    tickets,
  )
  const request = { user, body: { executionId: 'exec-id' }, params: { boxIdOrName: 'mybox' }, get: () => undefined }
  const { audit, result } = auditCall(BoxController.prototype.createAttachTicket, request, () =>
    (controller.createAttachTicket as any)(user, 'mybox', request.body, request),
  )
  await expect(result).rejects.toThrow('ticket persistence failed')
  expect(audit.updateLog).toHaveBeenCalledWith(
    'audit',
    expect.objectContaining({ statusCode: 500, targetId: 'box-id' }),
  )
})

it('audits experimental settings without recording embedded credentials', async () => {
  const update = jest.fn().mockResolvedValue(undefined)
  const controller = new (OrganizationController as any)({ updateExperimentalConfig: update }) as OrganizationController
  const request = {
    user,
    params: { organizationId: 'org' },
    body: { otel: { headers: { authorization: 'private-otel-secret' } } },
    get: () => undefined,
  }
  const { audit, result } = auditCall(OrganizationController.prototype.updateExperimentalConfig, request, () =>
    controller.updateExperimentalConfig('org', request.body),
  )
  await result
  expect(update).toHaveBeenCalledWith('org', request.body)
  expect(audit.createLog).toHaveBeenCalledWith(
    expect.objectContaining({ targetId: 'org', metadata: { configuration: 'experimental', cleared: false } }),
  )
  expect(JSON.stringify(audit.createLog.mock.calls)).not.toContain('private-otel-secret')
})

describe('account adoption audit failures', () => {
  const secret = 'local-test-secret-'.repeat(3)
  async function token(key = secret) {
    return new SignJWT({ sub: 'auth0|secondary', primary_user_id: 'auth0|primary' })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience(ADOPT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('60s')
      .sign(new TextEncoder().encode(key))
  }
  function harness() {
    const linked = { adopt: jest.fn().mockResolvedValue(undefined) }
    const audit = {
      createLog: jest.fn().mockResolvedValue({ id: 'audit' }),
      updateLog: jest.fn().mockResolvedValue({}),
    }
    const service = new (AccountLinkService as any)(
      { getOrThrow: () => secret },
      linked,
      {},
      audit,
    ) as AccountLinkService
    return { linked, audit, service }
  }
  it('does not trust an invalid signature for either auditing or migration', async () => {
    const { linked, audit, service } = harness()
    await expect(service.adopt(await token('wrong-key'.repeat(5)))).rejects.toBeInstanceOf(UnauthorizedException)
    expect(linked.adopt).not.toHaveBeenCalled()
    expect(audit.createLog).not.toHaveBeenCalled()
  })
  it('refuses migration when audit creation fails', async () => {
    const { linked, audit, service } = harness()
    audit.createLog.mockRejectedValue(new Error('insert failed'))
    await expect(service.adopt(await token())).rejects.toThrow('insert failed')
    expect(linked.adopt).not.toHaveBeenCalled()
  })
  it('preserves a failed migration and sanitizes its recorded error even when audit completion fails', async () => {
    const { linked, audit, service } = harness()
    linked.adopt.mockRejectedValue(new Error('migration failed: private-detail'))
    audit.updateLog.mockRejectedValue(new Error('update failed'))
    await expect(service.adopt(await token())).rejects.toThrow('migration failed')
    expect(audit.updateLog).toHaveBeenCalledWith('audit', {
      statusCode: 500,
      errorMessage: 'Local account adoption failed.',
    })
  })
  it('records idempotent retry attempts without claiming cross-organization membership', async () => {
    const { audit, service } = harness()
    await service.adopt(await token())
    await service.adopt(await token())
    expect(audit.createLog).toHaveBeenCalledTimes(2)
    expect(audit.createLog.mock.calls.every(([entry]) => entry.organizationId === undefined)).toBe(true)
  })
})

it('identifies the organization when leaving it', async () => {
  const remove = jest.fn().mockResolvedValue(undefined)
  const controller = new (OrganizationController as any)({}, { delete: remove }) as OrganizationController
  const request = { user, params: { organizationId: 'org' }, get: () => undefined }
  const { audit, result } = auditCall(OrganizationController.prototype.leave, request, () =>
    controller.leave(user as never, 'org'),
  )
  await result
  expect(remove).toHaveBeenCalledWith('org', user.userId)
  expect(audit.createLog).toHaveBeenCalledWith(
    expect.objectContaining({ action: 'leave_organization', targetType: 'organization', targetId: 'org' }),
  )
})

describe('account link audit targets', () => {
  afterEach(() => jest.restoreAllMocks())
  function controller(enabled = true) {
    const config: Record<string, unknown> = {
      'oidc.managementApi.enabled': enabled,
      'oidc.managementApi.tokenUrl': 'https://identity.example.test/oauth/token',
      'oidc.managementApi.baseUrl': 'https://identity.example.test/api/v2',
      'oidc.managementApi.clientId': 'client',
      'oidc.managementApi.clientSecret': 'test-secret',
      'oidc.managementApi.audience': 'https://identity.example.test/api/v2/',
    }
    return new UserController(
      { findOne: async (id: string) => (id === user.userId ? { emailVerified: true } : null) } as never,
      { get: (key: string) => config[key], getOrThrow: (key: string) => config[key] } as never,
    )
  }

  it.each(['link', 'unlink'])('records the secondary identity for %s', async (operation) => {
    jest.spyOn(axios, 'get').mockResolvedValue({ data: {} })
    jest.spyOn(axios, 'post').mockResolvedValue({ data: { access_token: 'test-management-token' } })
    const remove = jest.spyOn(axios, 'delete').mockResolvedValue({ data: {} })
    const body = { provider: 'github', userId: 'secondary' }
    const request = { user, body, params: { provider: 'github', providerUserId: 'secondary' }, get: () => undefined }
    const instance = controller()
    const handler = operation === 'link' ? UserController.prototype.linkAccount : UserController.prototype.unlinkAccount
    const { audit, result } = auditCall(handler, request, () =>
      operation === 'link'
        ? instance.linkAccount(user as never, body)
        : instance.unlinkAccount(user as never, 'github', 'secondary'),
    )
    await result
    if (operation === 'unlink') expect(remove).toHaveBeenCalledTimes(1)
    expect(audit.createLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: `${operation}_account`, targetType: 'user', targetId: 'github|secondary' }),
    )
    expect(JSON.stringify([audit.createLog.mock.calls, audit.updateLog.mock.calls])).not.toContain(
      'test-management-token',
    )
  })

  it.each([
    undefined,
    {},
    { provider: {}, userId: 'id' },
    { provider: 'github', userId: ['id'] },
    { provider: '', userId: 'id' },
    { provider: 'github', userId: '' },
  ])('does not manufacture an identity from malformed link input %j', async (body) => {
    const request = { user, body, params: {}, get: () => undefined }
    const { audit, result } = auditCall(UserController.prototype.linkAccount, request, () =>
      controller(false).linkAccount(user as never, body as never),
    )
    await expect(result).rejects.toThrow()
    expect(audit.createLog).toHaveBeenCalledWith(expect.objectContaining({ targetType: 'user', targetId: null }))
  })
})

it.each(['event', 'dto'])('keeps the recovered Box ID after a subsequent %s failure', async (failure) => {
  const box = new Box('us', 'friendly-name')
  box.state = BoxState.STARTING
  const subscriber = new EventEmitter()
  const controller = new BoxController(
    {} as never,
    {
      recover: async () => box,
      toBoxDto: async () => {
        if (failure === 'dto') throw new Error('DTO conversion failed')
        setImmediate(() =>
          subscriber.emit(
            'message',
            BOX_EVENT_CHANNEL,
            JSON.stringify({ box: { ...box, state: BoxState.ERROR, errorReason: 'startup failed' } }),
          ),
        )
        return box
      },
    } as never,
    { duplicate: () => ({ subscribe: () => undefined, on: subscriber.on.bind(subscriber) }) } as never,
    {} as never,
  )
  const request = { user, params: { boxIdOrName: 'friendly-name' }, get: () => undefined }
  const { audit, result } = auditCall(BoxController.prototype.recoverBox, request, () =>
    (controller.recoverBox as any)(user, 'friendly-name', request),
  )
  await expect(result).rejects.toThrow(failure === 'dto' ? 'DTO conversion failed' : 'startup failed')
  expect(audit.updateLog).toHaveBeenCalledWith(
    'audit',
    expect.objectContaining({ targetId: box.id, statusCode: failure === 'dto' ? 500 : 400 }),
  )
})
