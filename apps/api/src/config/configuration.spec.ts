/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

describe('configuration volume bucket prefix', () => {
  const originalVolumeBucketPrefix = process.env.VOLUME_BUCKET_PREFIX

  afterEach(() => {
    jest.resetModules()
    if (originalVolumeBucketPrefix === undefined) {
      delete process.env.VOLUME_BUCKET_PREFIX
    } else {
      process.env.VOLUME_BUCKET_PREFIX = originalVolumeBucketPrefix
    }
  })

  it('requires a volume bucket prefix', () => {
    delete process.env.VOLUME_BUCKET_PREFIX
    jest.isolateModules(() => {
      expect(() => require('./configuration')).toThrow('VOLUME_BUCKET_PREFIX is required')
    })
  })

  it('loads an explicitly configured volume bucket prefix', () => {
    process.env.VOLUME_BUCKET_PREFIX = 'boxlite-dev-volume-'
    jest.isolateModules(() => {
      const { configuration } = require('./configuration') as typeof import('./configuration')

      expect(configuration.s3.volumeBucketPrefix).toBe('boxlite-dev-volume-')
    })
  })

  it('rejects invalid operator-supplied volume bucket prefixes at config load', () => {
    process.env.VOLUME_BUCKET_PREFIX = 'BoxLite_volume_'

    jest.isolateModules(() => {
      expect(() => require('./configuration')).toThrow(/VOLUME_BUCKET_PREFIX/)
    })
  })
})
