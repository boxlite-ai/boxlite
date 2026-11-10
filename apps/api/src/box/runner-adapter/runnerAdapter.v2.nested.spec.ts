import { RunnerAdapterV2 } from './runnerAdapter.v2'
import { JobType } from '../enums/job-type.enum'
import { RunnerState } from '../enums/runner-state.enum'

describe('V2 saved nesting contract', () => {
  function fixture(report: Record<string, unknown> = {}) {
    const jobs = { createJob: jest.fn().mockResolvedValue(undefined) }
    const repository = {
      findOne: jest.fn().mockResolvedValue({
        id: 'runner',
        state: RunnerState.READY,
        lastChecked: new Date(),
        nestedVirtualizationEnabled: true,
        nestedVirtualizationStartEnabled: true,
        ...report,
      }),
    }
    // The repository is supplied by Nest in production.
    const adapter = new RunnerAdapterV2({} as any, {} as any, jobs as any)
    Object.assign(adapter, { runnerRepository: repository })
    void adapter.init({ id: 'runner', apiVersion: '2' } as any)
    return { adapter, jobs, repository }
  }

  it('reads the current report and forwards saved true through CREATE_BOX', async () => {
    const { adapter, jobs, repository } = fixture()
    await adapter.createBox({ id: 'box', nestedVirtualization: true } as any, 'base')
    expect(repository.findOne).toHaveBeenCalledWith({ where: { id: 'runner' }, cache: false })
    expect(jobs.createJob.mock.calls[0][1]).toBe(JobType.CREATE_BOX)
    expect(jobs.createJob.mock.calls[0][5]).toMatchObject({ nestedVirtualization: true })
  })

  it('forwards saved true through START_BOX', async () => {
    const { adapter, jobs } = fixture()
    await (adapter.startBox as any)('box', 'token', { key: 'value' }, true)
    expect(jobs.createJob.mock.calls[0][1]).toBe(JobType.START_BOX)
    expect(jobs.createJob.mock.calls[0][5]).toMatchObject({ nestedVirtualization: true, metadata: { key: 'value' } })
  })

  it.each([
    { nestedVirtualizationEnabled: undefined },
    { nestedVirtualizationEnabled: false },
    { nestedVirtualizationEnabled: 'true' },
    { lastChecked: new Date(0) },
    { state: RunnerState.UNRESPONSIVE },
  ])('refuses nested create before enqueueing for report %p', async (report) => {
    const { adapter, jobs } = fixture(report)
    await expect(adapter.createBox({ id: 'box', nestedVirtualization: true } as any, 'base')).rejects.toThrow(
      /nested virtualization/i,
    )
    expect(jobs.createJob).not.toHaveBeenCalled()
  })

  it.each([undefined, false, 'true'])('refuses start when start capability is %p', async (value) => {
    const { adapter, jobs } = fixture({ nestedVirtualizationStartEnabled: value })
    await expect((adapter.startBox as any)('box', 'token', {}, true)).rejects.toThrow(/nested virtualization/i)
    expect(jobs.createJob).not.toHaveBeenCalled()
  })

  it('leaves ordinary legacy requests unchanged without a capability lookup', async () => {
    const { adapter, jobs, repository } = fixture()
    await adapter.createBox({ id: 'box' } as any, 'base')
    await adapter.startBox('box', 'token', {})
    expect(repository.findOne).not.toHaveBeenCalled()
    for (const call of jobs.createJob.mock.calls) expect(call[5]).not.toHaveProperty('nestedVirtualization')
  })
})
