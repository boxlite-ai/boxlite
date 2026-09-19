/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

/**
 * The column and the field it was exposed as. Both spellings, because the name
 * travels: snake_case in the database and the schema doc, camelCase in the
 * entity, the DTO, the specification and every generated client.
 */
const RETIRED_NAMES = ['template_deactivation_timeout_minutes', 'templateDeactivationTimeoutMinutes']

/**
 * Where the name may still appear, and why.
 *
 * The generated clients and the dashboard fixture typed against them are debts
 * with a payer: they come off this list when the clients are regenerated at the
 * end of this change's pull request. The two migrations never do — one created
 * the column and one drops it, and a migration is a record of what happened
 * rather than a statement about the schema today.
 */
const STILL_ALLOWED = [
  'apps/api/src/migrations/1741087887225-migration.ts',
  'apps/api/src/migrations/post-deploy/1787200000000-drop-template-deactivation-timeout-migration',
  'apps/api/src/organization/retired-template-column.spec.ts',
  'apps/libs/api-client/',
  'apps/libs/api-client-go/',
  'apps/dashboard/src/mocks/fixtures.ts',
]

/**
 * The baseline migration is edited in place when a whole feature is removed
 * from it — `migrations/README.md` says so — which makes allowing the file
 * wholesale a way back in for the column it created. It may name it once, in
 * the `CREATE TABLE` that introduced it; a second mention is a new statement.
 */
const BASELINE_MIGRATION = 'apps/api/src/migrations/1741087887225-migration.ts'
const BASELINE_MENTIONS = 1

/**
 * Searching the whole of `apps/`, not just `apps/api/src`, is the point. When
 * this column went, both generated clients, a dashboard fixture typed against
 * one of them, the schema document and a developer repair script still carried
 * it — and that last one would have put the column back. A check scoped to the
 * service would have called the job done.
 *
 * `git grep` rather than a directory walk, so build output and caches — which
 * hold stale copies of exactly these files — are out of scope by construction.
 * It follows that this sees tracked content only: a reintroduction sitting in
 * an untracked file goes unnoticed until it is staged, which is the moment it
 * would matter.
 */
describe('the retired template deactivation column', () => {
  const repoRoot = resolve(__dirname, '../../../..')

  function filesMentioning(name: string): string[] {
    try {
      return execFileSync('git', ['grep', '-l', '--fixed-strings', name, '--', 'apps/'], {
        cwd: repoRoot,
        encoding: 'utf8',
      })
        .split('\n')
        .filter(Boolean)
    } catch (error) {
      // `git grep` exits 1 with no output when nothing matches, which is the
      // answer this test wants rather than a failure.
      if ((error as { status?: number }).status === 1) {
        return []
      }
      throw error
    }
  }

  it.each(RETIRED_NAMES)('survives only where it is still owed: %s', (name) => {
    const unexpected = filesMentioning(name).filter(
      (file) => !STILL_ALLOWED.some((allowed) => file.startsWith(allowed)),
    )

    expect(unexpected).toEqual([])
  })

  it('does not let the baseline migration grow a second mention', () => {
    const lines = execFileSync(
      'git',
      ['grep', '-c', '--fixed-strings', 'template_deactivation_timeout_minutes', '--', BASELINE_MIGRATION],
      { cwd: repoRoot, encoding: 'utf8' },
    )

    expect(Number(lines.trim().split(':').pop())).toBe(BASELINE_MENTIONS)
  })

  /**
   * A debt nobody can forget: once the clients are regenerated and the fixture
   * follows, these entries stop matching anything and this fails until they are
   * deleted. An allowlist that only ever grows is how a name creeps back.
   */
  it.each(STILL_ALLOWED)('still needs its allowance for %s', (allowed) => {
    const matching = RETIRED_NAMES.flatMap(filesMentioning).filter((file) => file.startsWith(allowed))

    expect(matching.length).toBeGreaterThan(0)
  })
})
