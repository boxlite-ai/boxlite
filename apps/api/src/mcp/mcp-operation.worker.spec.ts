/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { McpOperationWorker } from './mcp-operation.worker'
import { McpOperation } from './mcp-operation.store'
import { BoxState } from '../box/enums/box-state.enum'
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common'
import {
  BoxCreationAdmissionUnavailableError,
  BoxCreationLimitExceededError,
} from '../box/errors/box-creation-limit.error'

describe('McpOperationWorker', () => {
  let worker: McpOperationWorker
  let operation: McpOperation
  let done: Promise<void>
  let complete: () => void
  const caller = { userId: 'user', email: 'user@test', organizationId: 'org', organization: { id: 'org' } }
  const box = { id: 'box', runnerId: 'runner', state: BoxState.STARTED, autoResume: true, autoStop: 10 }
  const store = {
    claim: jest.fn(),
    save: jest.fn(),
    renew: jest.fn(),
    read: jest.fn(),
    release: jest.fn(),
    releaseClaim: jest.fn(),
    expire: jest.fn(),
  }
  const output = { lease: jest.fn(), append: jest.fn(), finish: jest.fn() }
  const authorization = { authorize: jest.fn() }
  const boxes = { findOneByIdOrName: jest.fn(), updateLastActivityAt: jest.fn(), create: jest.fn() }
  const autoResume = { ensureReady: jest.fn() }
  const commerce = { resolveMaxCreatedBoxes: jest.fn() }
  const organizations = { assertOrganizationIsNotSuspended: jest.fn() }
  const encryption = { decrypt: jest.fn() }
  const runner = { start: jest.fn(), collect: jest.fn(), cancel: jest.fn(), status: jest.fn() }
  const audit = { createLog: jest.fn(), updateLog: jest.fn() }

  beforeEach(() => {
    jest.resetAllMocks()
    operation = {
      id: 'operation',
      organization_id: 'org',
      creator_id: 'user',
      identity: caller,
      tool: 'exec_box',
      state: 'dispatching',
      payload: 'encrypted',
      lease_epoch: 1,
      deadline_at: new Date(Date.now() + 60000),
    } as unknown as McpOperation
    done = new Promise((resolve) => {
      complete = resolve
    })
    store.claim.mockResolvedValueOnce(operation).mockResolvedValue(undefined)
    store.read.mockImplementation(async () => operation)
    store.renew.mockResolvedValue(true)
    store.save.mockImplementation(async (_op, progress) => {
      Object.assign(operation, progress)
      if (progress.state !== 'running') complete()
      return true
    })
    store.release.mockImplementation(async () => complete())
    authorization.authorize.mockResolvedValue(caller)
    boxes.findOneByIdOrName.mockResolvedValue(box)
    boxes.create.mockResolvedValue(box)
    encryption.decrypt.mockResolvedValue(
      JSON.stringify({ box_id: 'box', command: 'echo', args: [], timeout_seconds: 60 }),
    )
    audit.createLog.mockResolvedValue({ id: 'audit' })
    output.finish.mockResolvedValue(undefined)
    runner.start.mockResolvedValue('execution')
    runner.collect.mockResolvedValue(0)
    worker = new McpOperationWorker(
      store as never,
      output as never,
      authorization as never,
      boxes as never,
      autoResume as never,
      commerce as never,
      organizations as never,
      encryption as never,
      runner as never,
      audit as never,
    )
  })
  afterEach(async () => {
    await worker.onModuleDestroy()
    jest.useRealTimers()
  })

  it('rechecks authority after auto-resume, decodes split UTF-8, and treats nonzero exit as a result', async () => {
    runner.collect.mockImplementation(async (_box, _id, _signal, receive) => {
      await receive('stdout', Buffer.from([0xe4, 0xb8]))
      await receive('stdout', Buffer.from([0xad]))
      return 7
    })
    await worker.tick()
    await done
    expect(authorization.authorize).toHaveBeenCalledTimes(2)
    expect(autoResume.ensureReady).toHaveBeenCalledWith('box', caller.organization)
    expect(output.append).toHaveBeenCalledWith(operation, 'stdout', '中')
    expect(operation).toMatchObject({
      state: 'succeeded',
      process_state: 'exited',
      collection_state: 'finished',
      exit_code: 7,
    })
    expect(audit.createLog.mock.calls[0][0].metadata).toEqual({ operation_id: 'operation', tool: 'exec_box' })
  })
  it('does not dispatch after the credential is revoked during resume', async () => {
    authorization.authorize.mockResolvedValueOnce(caller).mockRejectedValue(new Error('revoked'))
    await worker.tick()
    await done
    expect(runner.start).not.toHaveBeenCalled()
    expect(operation).toMatchObject({ state: 'failed', error_code: 'dispatch_rejected' })
  })
  it('records uncertainty after a lost dispatch response without retrying', async () => {
    runner.start.mockRejectedValue(new Error('lost response'))
    await worker.tick()
    await done
    await worker.tick()
    expect(runner.start).toHaveBeenCalledTimes(1)
    expect(operation).toMatchObject({ state: 'outcome_unknown', process_state: 'unknown' })
  })
  it('reattaches a known execution without decrypting or dispatching again', async () => {
    Object.assign(operation, { state: 'running', box_id: 'box', execution_id: 'execution', payload: null })
    authorization.authorize.mockRejectedValue(new Error('original credential expired'))
    await worker.tick()
    await done
    expect(runner.collect).toHaveBeenCalled()
    expect(runner.start).not.toHaveBeenCalled()
    expect(encryption.decrypt).not.toHaveBeenCalled()
  })
  it('releases the lease for reattachment after a broken stream while the process runs', async () => {
    runner.collect.mockRejectedValue(new Error('disconnected'))
    runner.status.mockResolvedValue({ status: 'running' })
    await worker.tick()
    await done
    expect(store.release).toHaveBeenCalledWith(operation)
    expect(operation.state).toBe('running')
  })
  it('reports known process exit separately when the exit frame is missing', async () => {
    runner.collect.mockRejectedValue(new Error('disconnected'))
    runner.status.mockResolvedValue({ status: 'completed', exit_code: 2 })
    await worker.tick()
    await done
    expect(operation).toMatchObject({
      state: 'succeeded',
      process_state: 'exited',
      collection_state: 'interrupted',
      exit_code: 2,
    })
  })
  it('cancels a running execution after the runner acknowledges the kill', async () => {
    jest.useFakeTimers()
    runner.collect.mockImplementation((_box, _id, signal: AbortSignal) => {
      operation.cancel_requested = true
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stopped'))))
    })
    await worker.tick()
    await jest.advanceTimersByTimeAsync(300)
    await done
    expect(runner.cancel).toHaveBeenCalledWith(box, 'execution')
    expect(operation).toMatchObject({ state: 'cancelled', process_state: 'exited', collection_state: 'interrupted' })
    expect(store.release).not.toHaveBeenCalled()
  })
  it('retains a running process for recovery when cancellation is not acknowledged', async () => {
    jest.useFakeTimers()
    runner.collect.mockImplementation((_box, _id, signal: AbortSignal) => {
      operation.cancel_requested = true
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stopped'))))
    })
    runner.cancel.mockRejectedValue(new Error('runner unavailable'))
    runner.status.mockResolvedValue({ status: 'running' })
    await worker.tick()
    await jest.advanceTimersByTimeAsync(300)
    await done
    expect(operation.state).toBe('running')
    expect(store.release).toHaveBeenCalledWith(operation)
    expect(runner.start).toHaveBeenCalledTimes(1)
  })
  it('records uncertainty at the deadline without claiming process termination', async () => {
    jest.useFakeTimers()
    operation.deadline_at = new Date(Date.now() + 1000)
    runner.collect.mockImplementation(
      (_box, _id, signal: AbortSignal) =>
        new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')))),
    )
    await worker.tick()
    await jest.advanceTimersByTimeAsync(1000)
    await done
    expect(operation).toMatchObject({
      state: 'outcome_unknown',
      process_state: 'unknown',
      collection_state: 'interrupted',
    })
    expect(runner.start).toHaveBeenCalledTimes(1)
    expect(store.release).not.toHaveBeenCalled()
  })
  it('releases a known execution on shutdown for another collector to attach', async () => {
    let attached!: () => void
    const ready = new Promise<void>((resolve) => {
      attached = resolve
    })
    runner.collect.mockImplementation((_box, _id, signal: AbortSignal) => {
      attached()
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('stopped'))))
    })
    await worker.tick()
    await ready
    await worker.onModuleDestroy()
    expect(store.release).toHaveBeenCalledWith(operation)
    expect(runner.cancel).not.toHaveBeenCalled()
    expect(runner.status).not.toHaveBeenCalled()
    expect(operation.state).toBe('running')
  })
  it('cancels a known execution recovered after deadline without starting or attaching', async () => {
    Object.assign(operation, {
      state: 'outcome_unknown',
      cancel_requested: true,
      box_id: 'box',
      execution_id: 'execution',
      deadline_at: new Date(Date.now() - 1000),
      payload: null,
    })
    authorization.authorize.mockRejectedValue(new Error('original credential expired'))
    await worker.tick()
    await done
    expect(runner.cancel).toHaveBeenCalledWith(box, 'execution')
    expect(runner.start).not.toHaveBeenCalled()
    expect(runner.collect).not.toHaveBeenCalled()
    expect(operation).toMatchObject({ state: 'cancelled', process_state: 'exited' })
  })
  it('drains the replacement attempt after an older attempt for the same operation finishes', async () => {
    Object.assign(operation, { state: 'running', box_id: 'box', execution_id: 'execution', payload: null })
    const firstAttached = deferred<AbortSignal>()
    const nextAttached = deferred<AbortSignal>()
    const firstCollection = deferred<number>()
    const nextCollection = deferred<number>()
    runner.collect
      .mockImplementationOnce((_box, _id, signal: AbortSignal) => {
        firstAttached.resolve(signal)
        return firstCollection.promise
      })
      .mockImplementationOnce((_box, _id, signal: AbortSignal) => {
        signal.addEventListener('abort', () => nextCollection.reject(new Error('stopped')))
        nextAttached.resolve(signal)
        return nextCollection.promise
      })
    try {
      await worker.tick()
      await firstAttached.promise
      store.claim.mockResolvedValueOnce({ ...operation, lease_epoch: 2 })
      await worker.tick()
      const nextSignal = await nextAttached.promise
      firstCollection.resolve(0)
      await new Promise<void>(setImmediate)
      await worker.onModuleDestroy()
      expect(nextSignal.aborted).toBe(true)
      expect(store.release).toHaveBeenCalledWith(expect.objectContaining({ lease_epoch: 2 }))
    } finally {
      firstCollection.resolve(0)
      nextCollection.reject(new Error('test teardown'))
      await new Promise<void>(setImmediate)
    }
  })
  it('waits for a pending claim to be returned without dispatching during shutdown', async () => {
    const claimStarted = deferred<void>()
    const claimed = deferred<McpOperation>()
    const released = deferred<void>()
    store.claim.mockReset().mockImplementationOnce(() => {
      claimStarted.resolve()
      return claimed.promise
    })
    store.releaseClaim.mockReturnValue(released.promise)
    const polling = worker.tick()
    await claimStarted.promise
    let stopped = false
    const shutdown = worker.onModuleDestroy().then(() => {
      stopped = true
    })
    try {
      await new Promise<void>(setImmediate)
      expect(stopped).toBe(false)
      claimed.resolve(operation)
      await new Promise<void>(setImmediate)
      expect(store.releaseClaim).toHaveBeenCalledWith(operation)
      expect(stopped).toBe(false)
      expect(authorization.authorize).not.toHaveBeenCalled()
      expect(runner.start).not.toHaveBeenCalled()
      released.resolve()
      await shutdown
      expect(stopped).toBe(true)
    } finally {
      claimed.resolve(operation)
      released.resolve()
      await polling
      await shutdown
      await new Promise<void>(setImmediate)
    }
  })
  it('renews an expired execution cleanup lease while resolving its Box', async () => {
    jest.useFakeTimers()
    Object.assign(operation, {
      state: 'outcome_unknown',
      cancel_requested: true,
      box_id: 'box',
      execution_id: 'execution',
      deadline_at: new Date(Date.now() - 1000),
      payload: null,
    })
    boxes.findOneByIdOrName.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(box), 18000)))
    await worker.tick()
    await jest.advanceTimersByTimeAsync(18000)
    await done
    expect(store.renew.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(operation.state).toBe('cancelled')
  })
  it.each([
    new BadRequestException('resources exceed organization limit'),
    new ForbiddenException('organization suspended'),
    new ConflictException('name exists'),
    new BoxCreationLimitExceededError(1, 1),
    new BoxCreationAdmissionUnavailableError(),
  ])('releases a known Box creation admission rejection: %s', async (rejection) => {
    operation.tool = 'create_box'
    encryption.decrypt.mockResolvedValue(JSON.stringify({ image: 'python:3.12' }))
    boxes.create.mockRejectedValue(rejection)
    await worker.tick()
    await done
    expect(operation).toMatchObject({ state: 'failed', error_code: 'dispatch_rejected', process_state: 'not_started' })
  })
  it.each([BoxState.ERROR, BoxState.DESTROYED, BoxState.DESTROYING, 'missing'])(
    'releases a definitively failed creation in state %s',
    async (state) => {
      operation.tool = 'create_box'
      encryption.decrypt.mockResolvedValue(JSON.stringify({ image: 'python:3.12' }))
      if (state === 'missing') boxes.findOneByIdOrName.mockRejectedValue(new NotFoundException())
      else boxes.findOneByIdOrName.mockResolvedValue({ ...box, state })
      await worker.tick()
      await done
      expect(operation).toMatchObject({ state: 'failed', error_code: 'box_creation_failed', box_id: 'box' })
      expect(store.release).not.toHaveBeenCalled()
    },
  )
  it('uses commerce limits before creating and waits for the Box to start', async () => {
    operation.tool = 'create_box'
    encryption.decrypt.mockResolvedValue(JSON.stringify({ image: 'python:3.12' }))
    commerce.resolveMaxCreatedBoxes.mockResolvedValue(4)
    await worker.tick()
    await done
    expect(boxes.create).toHaveBeenCalledWith(
      expect.objectContaining({ image: 'python:3.12' }),
      caller.organization,
      expect.anything(),
      { maxCreatedBoxes: 4 },
    )
    expect(operation).toMatchObject({ state: 'succeeded', box_id: 'box', collection_state: 'not_applicable' })
  })
})

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
