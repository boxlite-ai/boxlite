import { Logger, INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { VolumeController } from './volume.controller'
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

  it.each(['admin', 'user'].flatMap((role) => ['create', 'delete'].map((operation) => [role, operation] as const)))(
    'records the %s actor for %s through UserContext',
    async (role, operation) => {
      const events: Array<Record<string, string>> = []
      jest.spyOn(Logger.prototype, 'log').mockImplementation((_message, attributes) => {
        if (attributes?.['event.name']?.startsWith('volume.')) events.push(attributes)
      })
      const stored = { id: 'volume-1', organizationId: 'org-1', name: 'workspace', state: VolumeState.READY }
      const repository = {
        findOne: jest.fn().mockResolvedValue(operation === 'delete' ? stored : null),
        save: jest.fn(async (volume) => volume),
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
        controllers: [VolumeController],
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
      const response = await fetch((await app.getUrl()) + '/volumes' + (operation === 'delete' ? '/volume-1' : ''), {
        method: operation === 'delete' ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json', 'X-BoxLite-Source': 'dashboard' },
        ...(operation === 'create' ? { body: JSON.stringify({ name: 'workspace' }) } : {}),
      })
      expect(response.ok).toBe(true)
      expect(events.map((event) => event['event.outcome'])).toEqual(['requested', 'success'])
      for (const event of events)
        expect(event).toMatchObject({
          'event.name': 'volume.' + operation,
          'user.id': role === 'admin' ? 'admin-1' : 'user-1',
          'actor.kind': role,
          'auth.method': 'api_key',
          'client.source': 'dashboard',
        })
    },
  )
})
