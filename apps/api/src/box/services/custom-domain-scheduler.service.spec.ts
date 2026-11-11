/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { INestApplication, Logger } from '@nestjs/common'
import { ScheduleModule } from '@nestjs/schedule'
import { Test } from '@nestjs/testing'
import { TypedConfigService } from '../../config/typed-config.service'
import { CustomDomainSchedulerService } from './custom-domain-scheduler.service'
import { CustomDomainWorkflowService } from './custom-domain-workflow.service'

describe('custom-domain API scheduling', () => {
  let app: INestApplication
  let scheduler: CustomDomainSchedulerService
  const workflow = { advancePending: jest.fn(), maintain: jest.fn() }
  let settings: Record<string, boolean>

  beforeEach(async () => {
    jest.useFakeTimers()
    jest.resetAllMocks()
    settings = { 'customDomains.enabled': true, skipConnections: false }
    const module = await Test.createTestingModule({
      imports: [ScheduleModule.forRoot()],
      providers: [
        CustomDomainSchedulerService,
        { provide: TypedConfigService, useValue: { get: (key: string) => settings[key] } },
        { provide: CustomDomainWorkflowService, useValue: workflow },
      ],
    }).compile()
    app = module.createNestApplication()
    scheduler = app.get(CustomDomainSchedulerService)
  })
  afterEach(async () => {
    await app.close()
    jest.restoreAllMocks()
    jest.useRealTimers()
  })

  it('runs at actual application startup and every minute, then stops on close', async () => {
    await app.init()
    expect(workflow.advancePending).toHaveBeenCalledTimes(1)
    expect(workflow.maintain).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(59_999)
    expect(workflow.advancePending).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(1)
    expect(workflow.advancePending).toHaveBeenCalledTimes(2)
    expect(workflow.maintain).toHaveBeenCalledTimes(2)
    await app.close()
    await jest.advanceTimersByTimeAsync(120_000)
    expect(workflow.advancePending).toHaveBeenCalledTimes(2)
  })

  it.each(['disabled', 'skipConnections'])('does no scheduled work when %s', async (mode) => {
    settings[mode === 'disabled' ? 'customDomains.enabled' : 'skipConnections'] = mode !== 'disabled'
    await app.init()
    await jest.advanceTimersByTimeAsync(120_000)
    expect(workflow.advancePending).not.toHaveBeenCalled()
    expect(workflow.maintain).not.toHaveBeenCalled()
  })

  it('logs failed rounds, still runs maintenance and retries on the next minute', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined)
    workflow.advancePending.mockRejectedValueOnce(new Error('database unavailable'))
    await app.init()
    expect(error).toHaveBeenCalledWith('Custom domain advancement round failed', 'database unavailable')
    expect(workflow.maintain).toHaveBeenCalledTimes(1)
    workflow.maintain.mockRejectedValueOnce(new Error('cleanup unavailable'))
    await jest.advanceTimersByTimeAsync(60_000)
    expect(error).toHaveBeenCalledWith('Custom domain maintenance round failed', 'cleanup unavailable')
    await jest.advanceTimersByTimeAsync(60_000)
    expect(workflow.advancePending).toHaveBeenCalledTimes(3)
    expect(workflow.maintain).toHaveBeenCalledTimes(3)
  })

  it('awaits startup work and skips overlapping minute rounds', async () => {
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    workflow.advancePending.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
          entered()
        }),
    )
    let initialized = false
    const initializing = app.init().then(() => {
      initialized = true
    })
    await started
    await jest.advanceTimersByTimeAsync(120_000)
    expect(initialized).toBe(false)
    expect(workflow.advancePending).toHaveBeenCalledTimes(1)
    release()
    await initializing
    await jest.advanceTimersByTimeAsync(60_000)
    expect(workflow.advancePending).toHaveBeenCalledTimes(2)
  })

  it('awaits an active round on shutdown and rejects new ticks', async () => {
    await app.init()
    let release!: () => void
    workflow.maintain.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )
    const round = scheduler.checkDue()
    let destroyed = false
    const closing = app.close().then(() => {
      destroyed = true
    })
    await jest.advanceTimersByTimeAsync(120_000)
    expect(destroyed).toBe(false)
    expect(workflow.maintain).toHaveBeenCalledTimes(2)
    release()
    await Promise.all([round, closing])
    await scheduler.checkDue()
    expect(workflow.maintain).toHaveBeenCalledTimes(2)
  })
})
