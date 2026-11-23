import { validateSync } from 'class-validator'
import { RunnerService } from './runner.service'
import { RunnerHealthcheckDto } from '../dto/runner-health.dto'
import { RunnerState } from '../enums/runner-state.enum'

describe('Runner nesting reports', () => {
  it.each([undefined, false, true])('persists strict support and clears old true for %p', async (value) => {
    const service = Object.create(RunnerService.prototype) as RunnerService
    const write = jest.fn().mockResolvedValue(true)
    Object.assign(service, {
      logger: { debug: jest.fn() },
      findOne: jest.fn().mockResolvedValue({ id: 'runner', state: RunnerState.READY }),
      updateRunnerUnlessDecommissioned: write,
      eventEmitter: { emit: jest.fn() },
    })
    await service.updateRunnerHealth('runner', undefined, undefined, undefined, undefined, undefined, 'dev', false, {
      nestedVirtualizationEnabled: value,
    })
    expect(write).toHaveBeenCalledWith(
      'runner',
      expect.objectContaining({
        nestedVirtualizationEnabled: value === true,
      }),
    )
  })

  it('does not replace capabilities after an info-read failure', async () => {
    const service = Object.create(RunnerService.prototype) as RunnerService
    const write = jest.fn().mockResolvedValue(true)
    Object.assign(service, {
      logger: { debug: jest.fn() },
      findOne: jest.fn().mockResolvedValue({ id: 'runner', state: RunnerState.READY }),
      updateRunnerUnlessDecommissioned: write,
      eventEmitter: { emit: jest.fn() },
    })
    await service.updateRunnerHealth(
      'runner',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { infoFailed: true },
    )
    expect(write.mock.calls[0][1]).not.toHaveProperty('nestedVirtualizationEnabled')
  })

  it.each([null, 'true', 1])('rejects invalid capability %p on the heartbeat boundary', (value) => {
    const dto = Object.assign(new RunnerHealthcheckDto(), {
      appVersion: 'dev',
      nestedVirtualizationEnabled: value,
    })
    expect(validateSync(dto).map((error) => error.property)).toEqual(
      expect.arrayContaining(['nestedVirtualizationEnabled']),
    )
  })
})
