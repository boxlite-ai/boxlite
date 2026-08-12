/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { boxMigrationConfig } from './configuration'

describe('boxMigrationConfig', () => {
  it('defaults to the box-migrations namespace of the runner bucket', () => {
    expect(boxMigrationConfig({})).toEqual({ archivePrefix: 'box-migrations/' })
  })

  it.each([
    ['a blank value', '   '],
    ['an unset value', undefined],
  ])('falls back to the default for %s', (_case, value) => {
    expect(boxMigrationConfig({ BOX_MIGRATION_ARCHIVE_PREFIX: value })).toEqual({
      archivePrefix: 'box-migrations/',
    })
  })

  // The prefix is concatenated with "<boxId>.boxlite", so the trailing slash has
  // to be there whether or not the operator wrote one.
  it.each([
    ['no trailing slash', 'migrate/archives', 'migrate/archives/'],
    ['a trailing slash', 'migrate/archives/', 'migrate/archives/'],
    ['repeated trailing slashes', 'migrate/archives//', 'migrate/archives/'],
    ['surrounding whitespace', '  migrate/archives  ', 'migrate/archives/'],
  ])('normalizes %s', (_case, value, expected) => {
    expect(boxMigrationConfig({ BOX_MIGRATION_ARCHIVE_PREFIX: value }).archivePrefix).toBe(expected)
  })

  // A bucket-qualified prefix is what lets one migration span two runners whose
  // own buckets differ; the runner resolves s3://<bucket>/<key> itself.
  it.each([
    ['a bucket and namespace', 's3://archives/tenant-a', 's3://archives/tenant-a/'],
    ['a bucket alone', 's3://archives', 's3://archives/'],
  ])('keeps %s bucket-qualified', (_case, value, expected) => {
    expect(boxMigrationConfig({ BOX_MIGRATION_ARCHIVE_PREFIX: value }).archivePrefix).toBe(expected)
  })

  // Each of these either uploads to a key nobody would look under or is rejected
  // by the runner on every job it is handed — both are worth a boot failure.
  it.each([
    ['a leading slash', '/box-migrations'],
    ['a doubled slash', 'box//migrations'],
    ['a traversal segment', 'box-migrations/../escaped'],
    ['a bare dot segment', 'box-migrations/./here'],
    ['an empty bucket', 's3:///box-migrations'],
    ['nothing but the scheme', 's3://'],
    ['only slashes', '//'],
    ['an inner space', 'box migrations'],
    ['a shell character', 'box-migrations;rm'],
  ])('refuses to start on %s', (_case, value) => {
    expect(() => boxMigrationConfig({ BOX_MIGRATION_ARCHIVE_PREFIX: value })).toThrow(
      /BOX_MIGRATION_ARCHIVE_PREFIX must be a slash-separated object-store prefix/,
    )
  })
})
