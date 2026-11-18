/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { emitTiming, resetTimingForTest, snapshotTiming, startTiming } from './tti-timing.util'

describe('TTI timing', () => {
  const now = new Date('2026-09-30T08:00:00.000Z')

  beforeEach(() => {
    resetTimingForTest()
    jest.useFakeTimers({ doNotFake: ['hrtime'] }).setSystemTime(now)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
    resetTimingForTest()
  })

  it('records exactly the eight runner fields and keeps zero elapsed milliseconds', () => {
    jest.spyOn(process.hrtime, 'bigint').mockReturnValueOnce(0n).mockReturnValueOnce(999_999n)
    emitTiming('exec', 'exec.started', 'ok', startTiming(), { box_id: 'box-1', job_id: 'job-1', exec_id: 'exec-1' })

    const event = {
      op: 'exec',
      stage: 'exec.started',
      status: 'ok',
      dur_ms: 0,
      box_id: 'box-1',
      job_id: 'job-1',
      exec_id: 'exec-1',
      ts: '2026-09-30T08:00:00.000Z',
    }
    const events = snapshotTiming('box-1')
    expect(events).toStrictEqual([event])
    expect(JSON.parse(JSON.stringify(events))).toStrictEqual([event])
  })

  it('uses whole milliseconds from the monotonic clock, not elapsed wall time', () => {
    jest.spyOn(process.hrtime, 'bigint').mockReturnValueOnce(100_000_000n).mockReturnValueOnce(102_999_999n)
    const startedAt = startTiming()
    jest.setSystemTime(new Date('2026-09-30T07:00:00.000Z'))
    emitTiming('create', 'create.request', 'error', startedAt, { box_id: 'box-1' })

    const [{ dur_ms, ts }] = snapshotTiming('box-1')
    expect(dur_ms).toBe(2)
    expect(Number.isInteger(dur_ms)).toBe(true)
    expect(ts).toBe('2026-09-30T07:00:00.000Z')
  })

  it('omits missing IDs and discards events without a box ID', () => {
    const startedAt = startTiming()
    emitTiming('destroy', 'destroy.request', 'skipped', startedAt, { box_id: 'box-1', job_id: '', exec_id: null })
    emitTiming('destroy', 'destroy.request', 'skipped', startedAt, { box_id: 'box-1', job_id: undefined })
    emitTiming('exec', 'exec.request', 'error', startedAt, { job_id: 'box-1' })
    emitTiming('exec', 'exec.request', 'error', startedAt, { box_id: '' })
    emitTiming('exec', 'exec.request', 'error', startedAt, { box_id: null })

    const event = {
      op: 'destroy',
      stage: 'destroy.request',
      status: 'skipped',
      dur_ms: expect.any(Number),
      box_id: 'box-1',
      ts: now.toISOString(),
    }
    expect(snapshotTiming('box-1')).toStrictEqual([event, event])
    expect(snapshotTiming('')).toStrictEqual([])
    expect(snapshotTiming('undefined')).toStrictEqual([])
    expect(snapshotTiming('null')).toStrictEqual([])
  })

  it('keeps only the newest 256 events in write order without affecting other boxes', () => {
    const startedAt = startTiming()
    for (let i = 0; i < 280; i++) {
      emitTiming('exec', 'exec.started', 'ok', startedAt, { box_id: 'box-1', exec_id: String(i) })
      if (i === 137) emitTiming('create', 'create.request', 'ok', startedAt, { box_id: 'box-2' })
    }

    const events = snapshotTiming('box-1')
    expect(events.map((event) => event.exec_id)).toEqual(Array.from({ length: 256 }, (_, i) => String(i + 24)))
    expect(events.every((event) => event.box_id === 'box-1')).toBe(true)
    expect(snapshotTiming('box-2')).toEqual([expect.objectContaining({ op: 'create', box_id: 'box-2' })])
  })

  it('evicts the least recently written box over capacity without treating reads as writes', () => {
    const startedAt = startTiming()
    for (let i = 0; i < 1024; i++) {
      emitTiming('exec', 'exec.started', 'ok', startedAt, { box_id: String(i) })
    }
    emitTiming('exec', 'exec.finished', 'ok', startedAt, { box_id: '0' })
    expect(snapshotTiming('1')).toHaveLength(1)
    emitTiming('create', 'create.request', 'ok', startedAt, { box_id: '1024' })

    expect(snapshotTiming('1')).toStrictEqual([])
    expect(snapshotTiming('0').map((event) => event.stage)).toEqual(['exec.started', 'exec.finished'])
    expect(snapshotTiming('2')).toHaveLength(1)
    expect(snapshotTiming('1024')).toHaveLength(1)
  })

  it('returns detached snapshots and an empty array for an unknown box', () => {
    emitTiming('exec', 'exec.started', 'ok', startTiming(), { box_id: 'box-1', exec_id: 'original' })

    const events = snapshotTiming('box-1')
    events[0].exec_id = 'changed'
    events.pop()

    expect(snapshotTiming('box-1').map((event) => event.exec_id)).toEqual(['original'])
    expect(snapshotTiming('unknown')).toStrictEqual([])
  })

  it('clears all box histories on reset', () => {
    emitTiming('create', 'create.request', 'ok', startTiming(), { box_id: 'box-1' })
    emitTiming('create', 'create.request', 'ok', startTiming(), { box_id: 'box-2' })

    resetTimingForTest()

    expect(snapshotTiming('box-1')).toStrictEqual([])
    expect(snapshotTiming('box-2')).toStrictEqual([])
  })

  it('does not throw or change the business result when storing an event fails', () => {
    const businessResult = { id: 'box-1' }
    const startedAt = startTiming()
    const runBusiness = () => {
      try {
        return businessResult
      } finally {
        emitTiming('create', 'create.request', 'ok', startedAt, { box_id: businessResult.id })
      }
    }
    const failWrite = jest.fn(() => {
      throw new Error('storage failed')
    })
    const writeSpy = jest.spyOn(Map.prototype, 'set').mockImplementationOnce(failWrite)
    const result = runBusiness()
    writeSpy.mockRestore()

    expect(failWrite).toHaveBeenCalledWith('box-1', expect.any(Object))
    expect(result).toBe(businessResult)
    expect(snapshotTiming('box-1')).toStrictEqual([])
  })

  it('skips timing if capturing the start fails', () => {
    jest.spyOn(process.hrtime, 'bigint').mockImplementationOnce(() => {
      throw new Error('clock failed')
    })

    const startedAt = startTiming()
    expect(startedAt).toBeUndefined()
    expect(() => emitTiming('exec', 'exec.started', 'ok', startedAt, { box_id: 'box-1' })).not.toThrow()
    expect(snapshotTiming('box-1')).toStrictEqual([])
  })
})
