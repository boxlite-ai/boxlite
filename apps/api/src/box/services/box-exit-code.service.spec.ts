/*
 * SPDX-License-Identifier: AGPL-3.0
 * Copyright (c) 2026 BoxLite AI
 */

import { BoxExitCodeService } from './box-exit-code.service'
import { Box } from '../entities/box.entity'
import { BoxState } from '../enums/box-state.enum'

describe('BoxExitCodeService', () => {
  const runner = { id: 'runner-1', apiUrl: 'https://runner.invalid', apiKey: 'k' }

  // `null` rather than `undefined` for "no runner": passing undefined would
  // fall back to the default parameter and quietly test the wrong thing.
  function boxIn(state: BoxState, runnerId: string | null = 'runner-1'): Box {
    const box = new Box('us', 'loader')
    box.id = 'box-1'
    box.state = state
    box.runnerId = runnerId ?? undefined
    return box
  }

  // Replaces only the HTTP client, so the state gate, the `?? undefined` and
  // the failure handling below all run for real.
  class ServiceWithStubbedRunner extends BoxExitCodeService {
    constructor(
      runnerService: unknown,
      private readonly reply: () => Promise<{ data: unknown }>,
    ) {
      super(runnerService as never)
    }
    protected override buildClient(): never {
      return { info: () => this.reply() } as never
    }
  }

  function serviceThatReads(payload: unknown, runnerService = { findOne: jest.fn().mockResolvedValue(runner) }) {
    const info = jest.fn().mockResolvedValue({ data: payload })
    return { service: new ServiceWithStubbedRunner(runnerService, info), info, runnerService }
  }

  beforeEach(() => jest.clearAllMocks())

  // The whole point of the field: absence and 0 are different answers, and a
  // truthiness check anywhere on this path erases every clean exit.
  it.each([
    ['a main command ended by a signal', { exitCode: 137 }, 137],
    ['a main command that succeeded', { exitCode: 0 }, 0],
  ])('returns the code for %s', async (_case, payload, expected) => {
    const { service } = serviceThatReads({ state: 'stopped', ...payload })

    await expect(service.getExitCode(boxIn(BoxState.STOPPED))).resolves.toBe(expected)
  })

  // ERROR is an asking state too: a box that failed on its own may still have
  // a code the runtime recorded, and that is exactly when someone wants it.
  it('asks the runner about a box in error', async () => {
    const { service, runnerService } = serviceThatReads({ state: 'error', exitCode: 1 })

    await expect(service.getExitCode(boxIn(BoxState.ERROR))).resolves.toBe(1)
    expect(runnerService.findOne).toHaveBeenCalled()
  })

  it('returns undefined when the runner recorded no exit code', async () => {
    const { service } = serviceThatReads({ state: 'stopped' })

    await expect(service.getExitCode(boxIn(BoxState.STOPPED))).resolves.toBeUndefined()
  })

  // This is the boundary `null` can actually cross: the runner's JSON. It is
  // coalesced here so no layer above has to admit the shape, which is why
  // nothing downstream guards against it any more.
  it('coalesces a null from the runner to undefined', async () => {
    const { service } = serviceThatReads({ state: 'stopped', exitCode: null })

    await expect(service.getExitCode(boxIn(BoxState.STOPPED))).resolves.toBeUndefined()
  })

  // A box read must not fail because a runner is down. The cost is that an
  // unreachable runner is indistinguishable from "no code recorded", which is
  // the known trade of not storing a copy.
  it('degrades to undefined when the runner cannot be reached', async () => {
    const service = new ServiceWithStubbedRunner({ findOne: jest.fn().mockResolvedValue(runner) }, () =>
      Promise.reject(new Error('ECONNREFUSED')),
    )

    await expect(service.getExitCode(boxIn(BoxState.STOPPED))).resolves.toBeUndefined()
  })

  // Asking about a box that is up costs a round trip and can only ever answer
  // "none": a running box's previous code belongs to the run that ended.
  it.each([
    [BoxState.STARTED],
    [BoxState.STARTING],
    [BoxState.CREATING],
    [BoxState.RESTORING],
    [BoxState.DESTROYED],
  ])('does not ask the runner about a box in %s', async (state) => {
    const { service, runnerService } = serviceThatReads({ state: 'stopped', exitCode: 42 })

    await expect(service.getExitCode(boxIn(state))).resolves.toBeUndefined()
    expect(runnerService.findOne).not.toHaveBeenCalled()
  })

  it('does not ask when the box has no runner', async () => {
    const { service, runnerService } = serviceThatReads({ state: 'stopped', exitCode: 42 })

    await expect(service.getExitCode(boxIn(BoxState.STOPPED, null))).resolves.toBeUndefined()
    expect(runnerService.findOne).not.toHaveBeenCalled()
  })
})
