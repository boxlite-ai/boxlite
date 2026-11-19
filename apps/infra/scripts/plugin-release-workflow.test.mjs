import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const workflow = load(readFileSync(join(root, '.github/workflows/release-plugins.yml'), 'utf8'))
const packageScript = workflow.jobs.build.steps.find((step) => step.id === 'package').run
const publishScript = workflow.jobs.publish.steps.find((step) => step.run).run
const { version } = JSON.parse(readFileSync(join(root, 'plugins/boxlite/plugin.json'), 'utf8'))
const tag = `boxlite-plugin-v${version}`
const files = [
  `boxlite-${version}.zip`,
  `boxlite-marketplace-${version}.zip`,
  'SHA256SUMS',
  `boxlite-review-kit-${version}.zip`,
  `boxlite-review-kit-${version}.zip.sha256`,
]

// Exercise the workflow against archives produced by the real package builder.
before(() => {
  const built = spawnSync('make', ['--no-print-directory', 'plugin:boxlite:review-kit'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 90_000,
  })
  assert.equal(built.status, 0, built.error?.message ?? built.stderr)
})

function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'boxlite-plugin-release-'))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}

for (const [event, refType, ref, allowed] of [
  ['pull_request', 'branch', 'preview', true],
  ['push', 'tag', tag, true],
  ['workflow_dispatch', 'tag', tag, true],
  ['push', 'tag', 'boxlite-plugin-v999999.0.0', false],
  ['workflow_dispatch', 'branch', 'main', false],
]) {
  test(`plugin package version gate: ${event} ${ref}`, (t) => {
    const output = join(directory(t), 'output')
    const run = spawnSync('bash', ['-c', packageScript], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: event,
        GITHUB_REF_TYPE: refType,
        GITHUB_REF_NAME: ref,
        GITHUB_RUN_ID: '123',
        GITHUB_RUN_ATTEMPT: '2',
        GITHUB_OUTPUT: output,
      },
    })
    assert.equal(run.status, allowed ? 0 : 1, run.error?.message ?? run.stderr)
    if (allowed) {
      assert.equal(readFileSync(output, 'utf8'), `version=${version}\nartifact=boxlite-plugins-${version}-123-2\n`)
    } else {
      assert.equal(existsSync(output), false)
    }
  })
}

function publish(t, fault) {
  const path = directory(t)
  const bin = join(path, 'bin')
  mkdirSync(bin)
  for (const file of files) copyFileSync(join(root, 'target/plugins', file), join(path, file))
  writeFileSync(join(path, 'private-evidence.json'), 'must never upload')
  if (fault === 'corrupt-package') writeFileSync(join(path, files[0]), 'damaged archive')
  const log = join(path, 'calls.jsonl')
  const summary = join(path, 'summary')
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n')
const fault = process.env.RELEASE_FAULT
if (args[0] === 'api') {
  if (args.some((arg) => arg.includes('releases?'))) {
    if (fault === 'api-error') process.exit(1)
    if (fault === 'existing') console.log('boxlite-plugin-v' + process.env.PLUGIN_VERSION)
  } else {
    console.log(fault === 'moved-tag' ? 'different-commit' : process.env.GITHUB_SHA)
  }
} else if (args[1] === 'create') {
  if (fault === 'upload-error') process.exit(1)
  if (!args.slice(-5).every((file) => fs.existsSync(file))) process.exit(2)
} else if (args[1] === 'edit') {
  if (fault === 'publish-error') process.exit(1)
} else if (args[1] === 'view') {
  console.log('https://example.invalid/release')
} else {
  process.exit(2)
}
`,
    { mode: 0o700 },
  )
  const run = spawnSync('bash', ['-c', publishScript], {
    cwd: path,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: bin + ':' + process.env.PATH,
      RELEASE_FAULT: fault,
      CALL_LOG: log,
      PLUGIN_VERSION: version,
      GH_REPO: 'fixture/repo',
      GH_TOKEN: 'fixture-token',
      GITHUB_SHA: 'a'.repeat(40),
      RUNNER_TEMP: path,
      GITHUB_STEP_SUMMARY: summary,
    },
  })
  assert.equal(run.error, undefined)
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : []
  const writes = calls.filter((args) => args[0] === 'release' && ['create', 'edit'].includes(args[1]))
  return { run, calls, writes, summary }
}

test('plugin release uploads exactly the five validated files before publishing', (t) => {
  const { run, calls, writes, summary } = publish(t, 'none')
  assert.equal(run.status, 0, run.stderr)
  assert.equal(writes.length, 2)
  assert.deepEqual(writes[0].slice(0, 3), ['release', 'create', tag])
  assert.deepEqual(writes[0].slice(-5), files)
  assert.ok(writes[0].includes('--draft') && writes[0].includes('--verify-tag'))
  assert.deepEqual(writes[1], ['release', 'edit', tag, '--draft=false', '--latest=false'])
  assert.ok(calls.every((args) => !args.includes('--clobber')))
  assert.equal(readFileSync(summary, 'utf8'), 'https://example.invalid/release\n')
})

for (const fault of ['existing', 'api-error', 'moved-tag', 'corrupt-package', 'upload-error', 'publish-error']) {
  test(`plugin release stops without success reporting on ${fault}`, (t) => {
    const { run, writes, summary } = publish(t, fault)
    assert.equal(run.status, 1, run.stderr)
    const expectedWrites = fault === 'upload-error' ? 1 : fault === 'publish-error' ? 2 : 0
    assert.equal(writes.length, expectedWrites)
    assert.equal(existsSync(summary), false)
    if (fault === 'upload-error') assert.equal(writes[0][1], 'create')
  })
}
