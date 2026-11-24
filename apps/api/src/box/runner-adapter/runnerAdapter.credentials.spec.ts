import { RunnerAdapterV0 } from './runnerAdapter.v0'
import { RunnerAdapterV2 } from './runnerAdapter.v2'

describe('Secret credential rollout', () => {
  const reference = {
    name: 'key',
    secretId: '00000000-0000-4000-8000-000000000001',
    hosts: ['example.com'],
    headers: { authorization: '{value}' },
  }
  const inline = { name: 'key', value: 'private', hosts: ['example.com'], headers: { authorization: '{value}' } }

  it.each([
    [true, [inline]],
    [false, [reference]],
  ])('rejects inconsistent v2 flag %s and stored secrets', async (enabled, secrets) => {
    const jobs = { createJob: jest.fn() }
    const issue = jest.fn()
    const adapter = new RunnerAdapterV2({} as any, {} as any, jobs as any)
    Object.assign(adapter, { config: { get: () => enabled }, credentials: { issue } })
    await adapter.init({ id: 'runner' } as any)
    await expect(adapter.createBox({ id: 'box', secrets } as any, 'base')).rejects.toThrow(/Secret/)
    expect(issue).not.toHaveBeenCalled()
    expect(jobs.createJob).not.toHaveBeenCalled()
  })

  it('does not issue credentials for empty boxes or START_BOX', async () => {
    const jobs = { createJob: jest.fn() }
    const issue = jest.fn()
    const adapter = new RunnerAdapterV2({} as any, {} as any, jobs as any)
    Object.assign(adapter, { config: { get: () => true }, credentials: { issue } })
    await adapter.init({ id: 'runner' } as any)
    await adapter.createBox({ id: 'box', secrets: [] } as any, 'base')
    await adapter.startBox('box', 'auth')
    expect(issue).not.toHaveBeenCalled()
    for (const call of jobs.createJob.mock.calls) expect(call[5]).not.toHaveProperty('secretCredential')
  })

  it.each([
    [true, reference],
    [false, reference],
    [true, inline],
  ])('rejects v0 create and recovery with flag %s', async (enabled, secret) => {
    const adapter = new RunnerAdapterV0()
    const client = { create: jest.fn(), recover: jest.fn() }
    Object.assign(adapter, { config: { get: () => enabled }, boxApiClient: client })
    const box = { id: 'box', secrets: [secret] } as any
    await expect(adapter.createBox(box, 'base')).rejects.toThrow('v2 runner')
    await expect(adapter.recoverBox(box)).rejects.toThrow('v2 runner')
    expect(client.create).not.toHaveBeenCalled()
    expect(client.recover).not.toHaveBeenCalled()
  })
})
