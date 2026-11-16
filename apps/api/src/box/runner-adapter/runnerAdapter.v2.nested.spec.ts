import { RunnerAdapterV2 } from './runnerAdapter.v2'
import { JobType } from '../enums/job-type.enum'
import { resolveNestedVirtualization } from './nested-virtualization-policy'
import { RunnerState } from '../enums/runner-state.enum'

describe('V2 optional nesting contract', () => {
  function fixture(report: Record<string, unknown> = {}) {
    const jobs = { createJob: jest.fn().mockResolvedValue(undefined) }
    const repository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'runner',
        state: RunnerState.READY,
        lastChecked: new Date(),
        nestedVirtualizationEnabled: true,
        ...report,
      }),
    }
    // The repository is supplied by Nest in production.
    const adapter = new RunnerAdapterV2({} as any, {} as any, jobs as any)
    Object.assign(adapter, { runnerRepository: repository })
    void adapter.init({ id: 'runner', apiVersion: '2' } as any)
    return { adapter, jobs, repository }
  }

  it.each([
    [{}, true],
    [{ nestedVirtualizationEnabled: undefined }, false],
    [{ nestedVirtualizationEnabled: false }, false],
    [{ nestedVirtualizationEnabled: 'true' }, false],
    [{ lastChecked: new Date(0) }, false],
    [{ state: RunnerState.UNRESPONSIVE }, false],
  ])('uses the fresh current report %p for create', async (report, expected) => {
    const { adapter, jobs, repository } = fixture(report as Record<string, unknown>)
    const allowed = await resolveNestedVirtualization(
      'org',
      {
        isNestedVirtualizationEnabled: jest.fn().mockResolvedValue(true),
      },
      adapter,
      50,
    )
    expect(allowed).toBe(expected)
    expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 'runner' }, cache: false })
    await adapter.createBox({ id: 'box' } as any, 'base', {}, allowed)
    expect(jobs.createJob.mock.calls.map((call) => call[1])).toEqual([JobType.CREATE_BOX])
    for (const call of jobs.createJob.mock.calls) {
      if (expected) expect(call[5]).toHaveProperty('nestedVirtualization', true)
      else expect(call[5]).not.toHaveProperty('nestedVirtualization')
    }
  })

  it('leaves ordinary legacy requests unchanged without a capability lookup', async () => {
    const { adapter, jobs, repository } = fixture()
    await adapter.createBox({ id: 'box' } as any, 'base')
    await adapter.startBox('box', 'token', {})
    expect(repository.findOne).not.toHaveBeenCalled()
    for (const call of jobs.createJob.mock.calls) expect(call[5]).not.toHaveProperty('nestedVirtualization')
  })
})
