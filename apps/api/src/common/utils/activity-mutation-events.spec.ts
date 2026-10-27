import { Logger } from '@nestjs/common'
import { ApiKeyService } from '../../api-key/api-key.service'
import { VolumeService } from '../../box/services/volume.service'
import { VolumeState } from '../../box/enums/volume-state.enum'
import { Context } from '../context/context'
import { PlatformReason } from '../context/platform-reason.enum'

const actor = Context.user({ userId: 'user-1', authMethod: 'api_key', clientSource: 'sdk', sdkVersion: '0.9.0' })
const bootstrap = Context.platform(PlatformReason.BOOTSTRAP)
const createKey = (service: ApiKeyService, ctx = actor) =>
  service.createApiKey('org-1', 'user-1', 'private-name', [], ctx, undefined, 'private-key-value')
const createVolume = (service: VolumeService) =>
  service.create({ id: 'org-1' } as never, { name: 'private-volume-name' }, actor)
const deleteVolume = (service: VolumeService, force = false) => service.delete('volume-1', actor, force)

describe('Activity business events for mutations', () => {
  let records: Array<Record<string, string>>
  beforeEach(() => {
    records = []
    const capture = (_message: unknown, attributes: unknown) => {
      if (attributes && typeof attributes === 'object' && 'event.name' in attributes)
        records.push(attributes as Record<string, string>)
    }
    jest.spyOn(Logger.prototype, 'log').mockImplementation(capture)
    jest.spyOn(Logger.prototype, 'error').mockImplementation(capture)
  })
  afterEach(() => jest.restoreAllMocks())
  const keyService = () => {
    const repository = { findOne: jest.fn().mockResolvedValue(null), save: jest.fn(async (value) => value) }
    return { repository, service: new ApiKeyService(repository as never, {} as never, {} as never, {} as never) }
  }
  const volumes = () => {
    const repository = { findOne: jest.fn().mockResolvedValue(null), save: jest.fn(async (value) => value) }
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
    return { repository, query, service }
  }
  const expectLifecycle = (name: string, outcome = 'success') => {
    expect(records.map((r) => [r['event.name'], r['event.outcome']])).toEqual([
      [name, 'requested'],
      [name, outcome],
    ])
    expect(records[0]).toMatchObject({
      'organization.id': 'org-1',
      'user.id': 'user-1',
      'auth.method': 'api_key',
      'client.source': 'sdk',
      'sdk.version': '0.9.0',
    })
    expect(records[0]['correlation.id']).toBe(records[1]['correlation.id'])
    expect(JSON.stringify(records)).not.toMatch(/private-|secret-/)
  }
  it('records API key creation with one non-secret correlation', async () => {
    const { service } = keyService()
    await createKey(service)
    expectLifecycle('api_key.create')
    expect(records[1]['correlation.id']).toMatch(/^[0-9a-f-]{36}$/)
  })
  it('records a rejected key creation without the key or database message', async () => {
    const { service, repository } = keyService()
    repository.save.mockRejectedValue(new Error('secret-database-message'))
    await expect(createKey(service)).rejects.toThrow('secret-database-message')
    expectLifecycle('api_key.create', 'exception')
    expect(records[1]['exception.type']).toBe('internal')
  })
  it('attributes bootstrap creation to the platform without a fictitious user', async () => {
    const { service } = keyService()
    await createKey(service, bootstrap)
    expect(records).toHaveLength(2)
    expect(records[1]).toMatchObject({ 'actor.kind': 'platform', 'event.reason': 'bootstrap' })
    expect(records[1]['user.id']).toBeUndefined()
  })
  it('records accepted volume creation, with the saved volume id', async () => {
    const { service } = volumes()
    const volume = await createVolume(service)
    expect(volume.state).toBe(VolumeState.PENDING_CREATE)
    expectLifecycle('volume.create')
    expect(records[1]['correlation.id']).toBe(volume.id)
  })
  it.each([false, true])('records deletion acceptance or in-use failure: %s', async (inUse) => {
    const { service, repository, query } = volumes()
    repository.findOne.mockResolvedValue({ id: 'volume-1', organizationId: 'org-1', state: VolumeState.READY })
    if (inUse) query.getOne.mockResolvedValue({ id: 'box-1', name: 'private-box-name' })
    if (inUse) await expect(deleteVolume(service)).rejects.toThrow('in use')
    else await deleteVolume(service)
    expectLifecycle('volume.delete', inUse ? 'exception' : 'success')
    expect(records[1]['correlation.id']).toBe('volume-1')
    if (inUse) expect(records[1]['exception.type']).toBe('conflict')
  })
  it('keeps force deletion of a missing volume an unrecorded no-op', async () => {
    await deleteVolume(volumes().service, true)
    expect(records).toEqual([])
  })
})
