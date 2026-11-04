/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { boxSnapshotConfig } from './configuration'

describe('boxSnapshotConfig', () => {
  it('leaves snapshots off without a prefix', () => {
    expect(boxSnapshotConfig({})).toEqual({ archivePrefix: undefined, maxPerOrganization: 10 })
    expect(boxSnapshotConfig({ BOX_SNAPSHOT_ARCHIVE_PREFIX: '   ' }).archivePrefix).toBeUndefined()
  })

  // Object keys are built as "<prefix><organization>/<snapshot>.boxlite", so the
  // prefix has to end in exactly one slash whatever the operator wrote.
  it.each([
    ['a bucket and namespace', 'gs://snapshots/box-snapshots', 'gs://snapshots/box-snapshots/'],
    ['a trailing slash', 'gs://snapshots/box-snapshots/', 'gs://snapshots/box-snapshots/'],
    ['a bucket alone', 'gs://snapshots', 'gs://snapshots/'],
    ['a dotted bucket', '  gs://boxlite.dev.snapshots/a/b  ', 'gs://boxlite.dev.snapshots/a/b/'],
  ])('normalizes %s', (_case, value, expected) => {
    expect(boxSnapshotConfig({ BOX_SNAPSHOT_ARCHIVE_PREFIX: value }).archivePrefix).toBe(expected)
  })

  // The S3 backend is reserved: accepting the prefix would fail every snapshot
  // the first time an archive had to be deleted.
  it('refuses an s3 prefix until the S3 backend exists', () => {
    expect(() => boxSnapshotConfig({ BOX_SNAPSHOT_ARCHIVE_PREFIX: 's3://bucket/snapshots' })).toThrow(
      /S3 snapshot storage is reserved and not implemented yet/,
    )
  })

  it.each([
    ['no scheme', 'snapshots/box'],
    ['an empty bucket', 'gs:///box'],
    ['an upper-case bucket', 'gs://Snapshots/box'],
    ['a one-letter bucket', 'gs://a/box'],
    ['a traversal segment', 'gs://snapshots/../escaped'],
    ['a doubled slash', 'gs://snapshots//box'],
    ['an inner space', 'gs://snapshots/box snapshots'],
  ])('refuses to start on %s', (_case, value) => {
    expect(() => boxSnapshotConfig({ BOX_SNAPSHOT_ARCHIVE_PREFIX: value })).toThrow(
      /BOX_SNAPSHOT_ARCHIVE_PREFIX must be gs:\/\/<bucket>\/<prefix>/,
    )
  })

  it.each([['0'], ['-1'], ['2.5'], ['many']])('refuses a per-organization limit of %s', (value) => {
    expect(() => boxSnapshotConfig({ BOX_SNAPSHOT_MAX_PER_ORGANIZATION: value })).toThrow(
      /BOX_SNAPSHOT_MAX_PER_ORGANIZATION must be a positive integer/,
    )
  })

  it('reads the per-organization limit', () => {
    expect(boxSnapshotConfig({ BOX_SNAPSHOT_MAX_PER_ORGANIZATION: '3' }).maxPerOrganization).toBe(3)
  })
})
