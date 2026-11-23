import { Logger, INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { VolumeController } from './volume.controller'
import { BoxliteVolumeController } from '../../boxlite-rest/boxlite-volume.controller'
import { Volume } from '../entities/volume.entity'
import { VolumeService } from '../services/volume.service'
import { VolumeState } from '../enums/volume-state.enum'
import { CombinedAuthGuard } from '../../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../../organization/guards/organization-resource-action.guard'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { VolumeAccessGuard } from '../guards/volume-access.guard'

describe('Volume HTTP caller attribution', () => {
  let app: INestApplication | undefined
  afterEach(async () => {
    await app?.close()
    jest.restoreAllMocks()
  })

  it.each(
    ['admin', 'user'].flatMap((role) =>
      ['create', 'delete'].flatMap((operation) =>
        ['/volumes', '/v1/volumes'].map((route) => [role, operation, route] as const),
      ),
    ),
  )('records the %s actor for %s through UserContext at %s', async (role, operation, route) => {
    const events: Array<Record<string, string>> = []
    jest.spyOn(Logger.prototype, 'log').mockImplementation((_message, attributes) => {
      if (attributes?.['event.name']?.startsWith('volume.')) events.push(attributes)
    })
    let stored: Volume | undefined =
      operation === 'delete'
        ? Object.assign(new Volume(), {
            id: 'volume-1',
            organizationId: 'org-1',
            name: 'workspace',
            state: VolumeState.READY,
            createdAt: new Date(),
            updatedAt: new Date(),
          })
        : undefined
    const repository = {
      findOne: jest.fn(async ({ where }) => (where.id && stored?.id === where.id ? stored : null)),
      save: jest.fn(async (volume: Volume) => {
        // Model worker completion at the IO boundary using the ID produced by VolumeService.
        if (volume.state === VolumeState.PENDING_CREATE) volume.state = VolumeState.READY
        stored = Object.assign(volume, { createdAt: new Date(), updatedAt: new Date() })
        return stored
      }),
    }
    const query = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      getOne: jest.fn().mockResolvedValue(null),
    }
    const service = new VolumeService(
      repository as never,
      { createQueryBuilder: () => query } as never,
      { assertOrganizationIsNotSuspended: jest.fn() } as never,
      { get: () => 'gcs' } as never,
      {} as never,
    )
    const module = Test.createTestingModule({
      controllers: [VolumeController, BoxliteVolumeController],
      providers: [{ provide: VolumeService, useValue: service }],
    })
    // Authentication is stubbed; decorator, controller and shared event service run unchanged.
    module.overrideGuard(CombinedAuthGuard).useValue({
      canActivate: (context) => {
        context.switchToHttp().getRequest().user = {
          userId: role === 'admin' ? 'admin-1' : 'user-1',
          role,
          apiKey: {},
          organizationId: 'org-1',
          organization: { id: 'org-1' },
        }
        return true
      },
    })
    for (const guard of [OrganizationResourceActionGuard, AuthenticatedRateLimitGuard, VolumeAccessGuard]) {
      module.overrideGuard(guard).useValue({ canActivate: () => true })
    }
    app = (await module.compile()).createNestApplication()
    await app.listen(0, '127.0.0.1')
    const response = await fetch((await app.getUrl()) + route + (operation === 'delete' ? '/volume-1' : ''), {
      method: operation === 'delete' ? 'DELETE' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BoxLite-Source': 'dashboard' },
      ...(operation === 'create' ? { body: JSON.stringify({ name: 'workspace' }) } : {}),
    })
    expect(response.ok).toBe(true)
    expect(events.map((event) => event['event.outcome'])).toEqual(['requested', 'success'])
    expect(stored).toBeDefined()
    if (operation === 'create') expect((await response.json()).id).toBe(stored!.id)
    for (const event of events)
      expect(event).toMatchObject({
        'event.name': 'volume.' + operation,
        'correlation.id': stored!.id,
        'user.id': role === 'admin' ? 'admin-1' : 'user-1',
        'actor.kind': role,
        'auth.method': 'api_key',
        'client.source': 'dashboard',
      })
  })
})
