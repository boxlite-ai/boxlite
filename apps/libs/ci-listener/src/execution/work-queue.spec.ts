/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { StateConflict } from '../state/database'
import { WorkQueue } from './work-queue'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('CI keyed execution queue', () => {
  it('coalesces pending work and requeues a running key once with its latest revision', async () => {
    const entered = deferred(),
      release = deferred(),
      repeated = deferred()
    const queue = new WorkQueue(2, (error) => {
      throw error
    })
    const intermediate = jest.fn(async () => {})
    let active = 0,
      maximum = 0
    queue.enqueue('a', '1', async () => {
      maximum = Math.max(maximum, ++active)
      entered.resolve()
      await release.promise
      active--
    })
    await entered.promise
    queue.enqueue('a', '2', intermediate)
    queue.enqueue('a', '3', async () => {
      maximum = Math.max(maximum, ++active)
      active--
      repeated.resolve()
    })
    queue.enqueue('a', '3', async () => {
      maximum = Math.max(maximum, ++active)
      active--
      repeated.resolve()
    })
    release.resolve()
    await repeated.promise
    await queue.close()
    expect(maximum).toBe(1)
    expect(intermediate).not.toHaveBeenCalled()
  })
  it('fills free consumer positions while another item is pending and rejects excess buffered work', async () => {
    const first = deferred(),
      second = deferred(),
      release = deferred(),
      third = deferred()
    const queue = new WorkQueue(
      2,
      (error) => {
        throw error
      },
      3,
    )
    let active = 0,
      maximum = 0
    const hold = async (entered: ReturnType<typeof deferred>) => {
      maximum = Math.max(maximum, ++active)
      entered.resolve()
      await release.promise
      active--
    }
    expect(queue.enqueue('a', '1', () => hold(first))).toBe(true)
    expect(queue.enqueue('b', '1', () => hold(second))).toBe(true)
    expect(
      queue.enqueue('c', '1', async () => {
        third.resolve()
      }),
    ).toBe(true)
    expect(queue.enqueue('d', '1', async () => {})).toBe(false)
    await Promise.all([first.promise, second.promise])
    expect(maximum).toBe(2)
    release.resolve()
    await third.promise
    await queue.close()
    expect(maximum).toBe(2)
  })
  it('stops claiming pending work during close and waits for the actual running operation', async () => {
    const entered = deferred(),
      release = deferred()
    const pending = jest.fn(async () => {})
    const queue = new WorkQueue(1, (error) => {
      throw error
    })
    queue.enqueue('a', '1', async () => {
      entered.resolve()
      await release.promise
    })
    queue.enqueue('b', '1', pending)
    await entered.promise
    let closed = false
    const closing = queue.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    expect(queue.enqueue('c', '1', pending)).toBe(false)
    release.resolve()
    await closing
    expect(pending).not.toHaveBeenCalled()
  })
  it('backs off failures and yields to periodic recovery after three attempts', async () => {
    const clock = jest.spyOn(Date, 'now')
    let now = 100000
    clock.mockImplementation(() => now)
    let reported = deferred()
    const report = jest.fn(() => reported.resolve())
    const queue = new WorkQueue(1, report)
    const fail = async () => {
      throw new Error('remote outcome remains uncertain')
    }
    try {
      for (const delay of [1000, 2000, 60000]) {
        reported = deferred()
        expect(queue.enqueue('a', '1', fail)).toBe(true)
        await reported.promise
        // Reporting precedes completion cleanup; wait for that completion signal.
        await new Promise<void>((resolve) => setImmediate(resolve))
        now += delay - 1
        expect(queue.enqueue('a', '1', fail)).toBe(false)
        now++
      }
      expect(report).toHaveBeenCalledTimes(3)
    } finally {
      await queue.close()
      clock.mockRestore()
    }
  })
  it('retains failure reporting errors without leaking active queue ownership', async () => {
    const queue = new WorkQueue(1, () => {
      throw new Error('observer failed')
    })
    queue.enqueue('a', '1', async () => {
      throw new Error('remote failed')
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(() => queue.enqueue('b', '1', async () => {})).toThrow('CI work reporting failed')
    await expect(queue.close()).rejects.toThrow('CI work reporting failed')
  })
  it('does not penalize a version conflict with a remote failure retry budget', async () => {
    const failed = deferred(),
      resumed = deferred()
    const queue = new WorkQueue(1, () => failed.resolve())
    queue.enqueue('a', '1', async () => {
      throw new StateConflict()
    })
    await failed.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(queue.enqueue('a', '2', async () => resumed.resolve())).toBe(true)
    await resumed.promise
    await queue.close()
  })
})
