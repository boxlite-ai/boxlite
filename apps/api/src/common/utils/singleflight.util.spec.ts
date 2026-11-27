/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Singleflight } from './singleflight.util'

describe('Singleflight', () => {
  it('shares one in-flight load between callers of the same key', async () => {
    const singleflight = new Singleflight()
    let release!: (value: string) => void
    const loader = jest.fn(() => new Promise<string>((resolve) => (release = resolve)))

    const first = singleflight.run('region:us', loader)
    const second = singleflight.run('region:us', loader)
    await Promise.resolve()
    release('ready')

    await expect(first).resolves.toBe('ready')
    await expect(second).resolves.toBe('ready')
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('retries after a rejected load', async () => {
    const singleflight = new Singleflight()
    const loader = jest.fn(() => Promise.resolve('recovered'))
    loader.mockRejectedValueOnce(new Error('database unavailable'))

    await expect(singleflight.run('org:1', loader)).rejects.toThrow('database unavailable')
    await expect(singleflight.run('org:1', loader)).resolves.toBe('recovered')
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('does not coalesce different keys', async () => {
    const singleflight = new Singleflight()
    const loader = jest.fn(async (value: string) => value)

    await expect(
      Promise.all([
        singleflight.run('runner:1', () => loader('one')),
        singleflight.run('runner:2', () => loader('two')),
      ]),
    ).resolves.toEqual(['one', 'two'])
    expect(loader).toHaveBeenCalledTimes(2)
  })
})
