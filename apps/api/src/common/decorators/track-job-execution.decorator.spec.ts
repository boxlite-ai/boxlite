/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { TrackJobExecution } from './track-job-execution.decorator'

describe('TrackJobExecution', () => {
  it('tracks concurrent calls of the same method independently', async () => {
    const completions: Array<() => void> = []

    class Worker {
      activeJobs = new Set<string>()

      @TrackJobExecution()
      async run() {
        await new Promise<void>((resolve) => completions.push(resolve))
      }
    }

    const worker = new Worker()
    const first = worker.run()
    const second = worker.run()
    expect(worker.activeJobs.size).toBe(2)

    completions[0]()
    await first
    expect(worker.activeJobs.size).toBe(1)

    completions[1]()
    await second
    expect(worker.activeJobs.size).toBe(0)
  })
})
