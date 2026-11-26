import { checkpointConfig } from './checkpoint-config'

describe('checkpoint storage configuration', () => {
  it('stays disabled without a bucket-qualified prefix', () => {
    expect(checkpointConfig({})).toEqual({
      archivePrefix: undefined,
      maxPerOrganization: 10,
      enabled: false,
      memoryEnabled: false,
    })
  })

  it.each(['gs://checkpoint-bucket/checkpoints', 'gs://checkpoint-bucket/checkpoints/'])('normalizes %s', (prefix) => {
    expect(checkpointConfig({ CHECKPOINT_ARCHIVE_PREFIX: prefix, CHECKPOINT_MAX_PER_ORGANIZATION: '20' })).toEqual({
      archivePrefix: 'gs://checkpoint-bucket/checkpoints/',
      maxPerOrganization: 20,
      enabled: false,
      memoryEnabled: false,
    })
  })

  it('requires explicit rollout enablement in addition to provisioned storage', () => {
    const storage = { CHECKPOINT_ARCHIVE_PREFIX: 'gs://checkpoint-bucket/checkpoints' }
    expect(checkpointConfig(storage).enabled).toBe(false)
    expect(checkpointConfig({ ...storage, CHECKPOINTS_ENABLED: 'false' }).enabled).toBe(false)
    expect(checkpointConfig({ ...storage, CHECKPOINTS_ENABLED: 'true' }).enabled).toBe(true)
    expect(checkpointConfig({ CHECKPOINTS_ENABLED: 'true' }).enabled).toBe(false)
    expect(() => checkpointConfig({ ...storage, CHECKPOINTS_ENABLED: 'yes' })).toThrow('CHECKPOINTS_ENABLED')
  })

  it('enables memory only with both rollout flags and archive storage', () => {
    const storage = { CHECKPOINT_ARCHIVE_PREFIX: 'gs://checkpoint-bucket/checkpoints' }
    const enabled = { ...storage, CHECKPOINTS_ENABLED: 'true' }
    const memory = { MEMORY_CHECKPOINTS_ENABLED: 'true' }
    expect(checkpointConfig(enabled).memoryEnabled).toBe(false)
    expect(checkpointConfig({ ...enabled, MEMORY_CHECKPOINTS_ENABLED: 'false' }).memoryEnabled).toBe(false)
    expect(checkpointConfig({ ...storage, ...memory }).memoryEnabled).toBe(false)
    expect(checkpointConfig({ CHECKPOINTS_ENABLED: 'true', ...memory }).memoryEnabled).toBe(false)
    expect(checkpointConfig({ ...enabled, ...memory }).memoryEnabled).toBe(true)
  })

  it.each(['', 'TRUE', '1', ' true '])('rejects invalid memory flag %j', (flag) => {
    expect(() => checkpointConfig({ MEMORY_CHECKPOINTS_ENABLED: flag })).toThrow('MEMORY_CHECKPOINTS_ENABLED')
  })

  it.each([
    's3://bucket/prefix',
    'gs:///prefix',
    'gs://bucket/a//b',
    'gs://bucket/../escape',
    'gs://bucket//prefix',
    'gs://bucket/a b',
    'file:///tmp/checkpoints',
  ])('rejects %s', (prefix) => {
    expect(() => checkpointConfig({ CHECKPOINT_ARCHIVE_PREFIX: prefix })).toThrow('CHECKPOINT_ARCHIVE_PREFIX')
  })

  it.each(['0', '-1', '1e3', '1.5', '9007199254740992'])('rejects invalid limit %s', (limit) => {
    expect(() => checkpointConfig({ CHECKPOINT_MAX_PER_ORGANIZATION: limit })).toThrow(
      'CHECKPOINT_MAX_PER_ORGANIZATION',
    )
  })
})
