import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { load } from 'js-yaml'

test('candidate and standalone release plans validate the exact tag, commit and pins', (t) => {
  const workflow = load(
    readFileSync(new URL('../../../../.github/workflows/mdeploy-all.yml', import.meta.url), 'utf8'),
  ) as any
  const step = workflow.jobs.resolve.steps.find((s: any) => s.id === 'pins')
  const dir = mkdtempSync(join(tmpdir(), 'mdeploy-release-pins-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const sha = 'a'.repeat(40),
    hash = 'sha256:' + 'f'.repeat(64)
  const pins = { tag: 'v1.2.3', sha, images: { api: hash }, runner: { manifest: hash, archive: hash } }
  writeFileSync(
    join(dir, 'gh'),
    `#!/bin/bash
if [[ "$2" == view ]]; then printf '{"isDraft":%s}' "$DRAFT"; else printf '%s' "$PINS" > "$RUNNER_TEMP/release-candidate.json"; fi
`,
    { mode: 0o755 },
  )
  const run = (candidate: boolean, data: object, draft = false) =>
    spawnSync('bash', ['-c', step.run], {
      cwd: dir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: dir + ':' + process.env.PATH,
        GITHUB_OUTPUT: join(dir, 'output'),
        RUNNER_TEMP: dir,
        TAG: pins.tag,
        SHA: sha,
        CANDIDATE_ID: '12',
        CANDIDATE_DIGEST: hash,
        RELEASE_CALLER: candidate ? sha : '',
        PINS: JSON.stringify(data),
        DRAFT: String(draft),
      },
    })
  for (const candidate of [true, false]) {
    const ok = run(candidate, pins)
    assert.equal(ok.status, 0, ok.stderr)
    assert.notEqual(run(candidate, { ...pins, tag: 'v2.0.0' }).status, 0)
    assert.notEqual(run(candidate, { ...pins, sha: 'b'.repeat(40) }).status, 0)
    assert.notEqual(run(candidate, { ...pins, runner: { archive: hash } }).status, 0)
  }
  assert.notEqual(run(false, pins, true).status, 0)
  assert.equal(run(true, pins, true).status, 0)
})
