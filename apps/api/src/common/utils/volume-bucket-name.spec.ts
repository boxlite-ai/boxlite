/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { resolveVolumeBucketName, validateVolumeBucketPrefix } from './volume-bucket-name'

describe('volume bucket names', () => {
  it('allows lowercase stage-scoped prefixes that fit with a UUID volume id', () => {
    expect(validateVolumeBucketPrefix('boxlite-dev-volume-')).toBe('boxlite-dev-volume-')
    expect(resolveVolumeBucketName('boxlite-dev-volume-', '00000000-0000-0000-0000-000000000000')).toBe(
      'boxlite-dev-volume-00000000-0000-0000-0000-000000000000',
    )
  })

  it.each(['BoxLite-volume-', 'boxlite_volume_', '-boxlite-volume-', 'boxlite.volume-'])(
    'rejects invalid prefix %s',
    (prefix) => {
      expect(() => validateVolumeBucketPrefix(prefix)).toThrow(/VOLUME_BUCKET_PREFIX/)
    },
  )

  it('rejects prefixes that cannot fit a UUID within the S3 bucket length limit', () => {
    expect(() => validateVolumeBucketPrefix('a'.repeat(28))).toThrow(/at most 27 characters/)
  })

  it('rejects computed bucket names that are not valid S3 bucket names', () => {
    expect(() => resolveVolumeBucketName('boxlite-volume-', 'volume-')).toThrow(/valid S3 bucket name/)
  })
})
