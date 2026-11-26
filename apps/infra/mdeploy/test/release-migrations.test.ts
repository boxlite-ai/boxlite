// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../../../api/scripts/release-migration-identities.cjs', import.meta.url))

test('release migration identities come from the selected commit and validate placement and suffix', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'release-migration-identities-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))

  // The pre-push hook sets Git's repository context for the parent worktree.
  const gitEnv = { ...process.env }
  const localNames = execFileSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8' })
  for (const name of localNames.trim().split('\n')) delete gitEnv[name]
  const git = (...args: string[]) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim()
  const add = (file: string, content: string) => {
    const path = join(cwd, 'apps/api/src/migrations', file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  const commit = () => {
    git('add', '.')
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'fixture',
    )
    return git('rev-parse', 'HEAD')
  }
  const identities = (revision: string) =>
    JSON.parse(
      execFileSync(process.execPath, [script, revision], {
        cwd,
        env: gitEnv,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    )

  git('init', '-q')
  add('1773000000000-baseline-migration.ts', 'export class Baseline1773000000000 {}\n')
  add('pre-deploy/1795000000000-add-migration.ts', 'export class Expand1795000000000 {}\n')
  const reviewed = commit()
  add('post-deploy/1795000000001-add.ts', 'export class Contract1795000000001 {}\n')
  const invalid = commit()
  assert.deepEqual(identities(reviewed), {
    baseline: ['Baseline1773000000000'],
    'pre-deploy': ['Expand1795000000000'],
    'post-deploy': [],
  })
  assert.throws(() => identities(invalid), /Invalid migration path/)
  assert.throws(() => identities('HEAD'), /Provide the full reviewed migration commit SHA/)
})
