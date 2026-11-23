import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const build = load(readFileSync(join(root, '.github/workflows/build-plugins.yml'), 'utf8'))
const publisher = load(readFileSync(join(root, '.github/workflows/publish-plugins.yml'), 'utf8'))
const packageScript = build.jobs.build.steps.find((step) => step.id === 'package').run
const verifyScript = publisher.jobs.verify.steps.find((step) => step.id === 'source').run
const publishScript = publisher.jobs.publish.steps.find((step) => step.id === 'registry').run
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

function execute(t, script, fault = 'none', overrides = {}) {
  const path = directory(t)
  const bin = join(path, 'bin')
  mkdirSync(bin)
  for (const file of files) copyFileSync(join(root, 'target/plugins', file), join(path, file))
  writeFileSync(join(path, 'private-evidence.json'), 'must never upload')
  if (fault === 'corrupt-package') writeFileSync(join(path, files[0]), 'damaged archive')
  const log = join(path, 'calls.jsonl')
  const output = join(path, 'output')
  writeFileSync(
    join(bin, 'fixture'),
    `#!/usr/bin/env node
const fs = require('node:fs')
const command = require('node:path').basename(process.argv[1])
const args = process.argv.slice(2)
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify([command, ...args]) + '\\n')
const fault = process.env.RELEASE_FAULT
const digest = 'sha256:' + 'a'.repeat(64)
if (command === 'gh' && args[0] === 'api') {
  const endpoint = args[1]
  if (fault === 'api-error') process.exit(1)
  if (endpoint.endsWith('/workflows/build-plugins.yml')) console.log('17')
  else if (endpoint.endsWith('/workflows/423888825')) console.log(fault === 'legacy-active' ? 'active' : 'disabled_manually')
  else if (endpoint.includes('/commits/tags%2F')) {
    const sha = fault === 'moved-tag' ? 'b'.repeat(40) : process.env.SOURCE_SHA
    console.log(args.includes('--jq') ? sha : JSON.stringify({
      sha, commit: { committer: { date: process.env.CREATED } },
    }))
  } else if (endpoint.includes('/compare/')) console.log(fault === 'unmerged' ? 'diverged' : 'ahead')
  else if (endpoint.includes('/artifacts?name=')) {
    const name = new URLSearchParams(endpoint.split('?')[1]).get('name')
    console.log(JSON.stringify({
      total_count: fault === 'ambiguous-artifact' ? 2 : 1,
      artifacts: [{ id: 1234, name: fault === 'stale-artifact' ? name.replace(/-2$/, '-1') : name,
        expired: fault === 'expired-artifact' }],
    }))
  } else process.exit(2)
} else if (command === 'curl') {
  if (args.includes('https://ghcr.io/token')) {
    if (fault === 'auth-error') process.exit(1)
    console.log(JSON.stringify({ token: 'registry-fixture' }))
  } else if (args.at(-1).includes('/tags/list')) {
    if (fault === 'uninitialized-package') process.exit(22)
  } else if (args.includes('--head')) {
    console.log(fault === 'lookup-error' ? '503' :
      ['same-digest', 'conflicting-version'].includes(fault) ? '200' : '404')
  } else process.exit(2)
} else if (command === 'oras') {
  if (args[0] === 'push' && args.includes('--oci-layout')) {
    if (!args.slice(-5).every((file) => fs.existsSync(file.split(':')[0]))) process.exit(2)
  } else if (args[0] === 'login') {
    assertPassword()
  } else if (args[0] === 'cp') {
    if (fault === 'upload-error') process.exit(1)
  } else if (args[0] === 'resolve') {
    console.log(!args.includes('--oci-layout') && ['conflicting-version', 'changed-digest'].includes(fault)
      ? 'sha256:' + 'b'.repeat(64) : digest)
  } else process.exit(2)
} else process.exit(2)

function assertPassword() {
  if (!args.includes('--password-stdin') || fs.readFileSync(0, 'utf8').trim() !== 'fixture-token') {
    process.exit(2)
  }
}
`,
    { mode: 0o700 },
  )
  for (const command of ['gh', 'curl', 'oras']) symlinkSync('fixture', join(bin, command))
  const run = spawnSync('bash', ['-c', script], {
    cwd: path,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: bin + ':' + process.env.PATH,
      RELEASE_FAULT: fault,
      CALL_LOG: log,
      VERSION: version,
      CREATED: '2026-11-20T00:00:00Z',
      SOURCE_TAG: tag,
      SOURCE_SHA: 'a'.repeat(40),
      BUILD_WORKFLOW: '17',
      BUILD_PATH: '.github/workflows/build-plugins.yml',
      BUILD_ID: '555',
      BUILD_ATTEMPT: '2',
      GITHUB_REPOSITORY: 'boxlite-ai/boxlite',
      GITHUB_SERVER_URL: 'https://github.com',
      GHCR_USER: 'fixture-user',
      GHCR_TOKEN: 'fixture-token',
      RUNNER_TEMP: path,
      GITHUB_OUTPUT: output,
      ...overrides,
    },
  })
  assert.equal(run.error, undefined)
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : []
  const copies = calls.filter(([command, subcommand]) => command === 'oras' && subcommand === 'cp')
  return { run, calls, copies, output: existsSync(output) ? readFileSync(output, 'utf8') : '' }
}

test('plugin build is read-only and publication uses only the verified attempt', (t) => {
  assert.deepEqual(build.permissions, { contents: 'read' })
  assert.deepEqual(Object.keys(build.jobs), ['build'])
  assert.deepEqual(publisher.on.workflow_run.workflows, [build.name])
  assert.match(publisher.jobs.verify.if, /workflow_run.conclusion == 'success'/)
  assert.match(publisher.jobs.verify.if, /workflow_run.head_repository.full_name == github.repository/)
  assert.match(publisher.jobs.verify.if, /github.ref == 'refs\/heads\/main'/)
  assert.doesNotMatch(publisher.jobs.verify.if, /pull_request/)
  assert.equal(publisher.jobs.publish.needs, 'verify')
  assert.equal(publisher.jobs.publish.environment, 'boxlite-plugin-ghcr')
  assert.equal(publisher.jobs.publish.permissions.packages, undefined)
  assert.match(publisher.jobs.publish.steps[0].with['artifact-ids'], /needs.verify.outputs.artifact_id/)
  assert.equal(publisher.jobs.publish.steps[0].with['merge-multiple'], true)

  const { run, calls, output } = execute(t, verifyScript)
  assert.equal(run.status, 0, run.stderr)
  const settings = new Map(output.trim().split('\n').map((line) => line.split(/=(.*)/s).slice(0, 2)))
  assert.equal(settings.get('version'), version)
  assert.equal(settings.get('artifact_id'), '1234')
  assert.equal(settings.get('created'), '2026-11-20T00:00:00Z')
  assert.ok(settings.has('build_source'), 'verifier provides the tagged build identity to the signer')
  assert.deepEqual(JSON.parse(settings.get('build_source')), { commit: 'a'.repeat(40), runId: '555', runAttempt: '2' })
  const sourceAttestation = publisher.jobs.publish.steps.find((step) => step.id === 'attest-source')
  assert.match(sourceAttestation.uses, /^actions\/attest@/)
  assert.deepEqual(sourceAttestation.with, {
    'subject-name': '${{ steps.registry.outputs.image }}',
    'subject-digest': '${{ steps.registry.outputs.digest }}',
    'predicate-type': 'https://boxlite.ai/attestations/plugin-build-source/v1',
    predicate: '${{ needs.verify.outputs.build_source }}',
  })
  assert.ok(calls.some((args) => args.includes(
    `repos/boxlite-ai/boxlite/actions/runs/555/artifacts?name=boxlite-plugins-${version}-555-2`,
  )))
})

for (const fault of ['legacy-active', 'api-error', 'moved-tag', 'unmerged', 'stale-artifact', 'expired-artifact', 'ambiguous-artifact']) {
  test(`plugin verifier rejects ${fault}`, (t) => {
    const { run, calls, output } = execute(t, verifyScript, fault)
    assert.notEqual(run.status, 0)
    assert.equal(output, '')
    assert.ok(calls.every(([command]) => command === 'gh'))
  })
}

test('plugin verifier rejects a same-name workflow with a different identity', (t) => {
  const { run, output } = execute(t, verifyScript, 'none', { BUILD_WORKFLOW: '18' })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /canonical plugin builder/)
  assert.equal(output, '')
})

for (const [fault, expectedCopies] of [['none', 1], ['same-digest', 0]]) {
  test(`plugin publisher verifies five OCI layers and emits the digest on ${fault}`, (t) => {
    const { run, calls, copies, output } = execute(t, publishScript, fault)
    assert.equal(run.status, 0, run.stderr)
    const layout = calls.find(([command, subcommand]) => command === 'oras' && subcommand === 'push')
    assert.ok(layout.includes('--oci-layout'))
    assert.ok(layout.includes('org.opencontainers.image.created=2026-11-20T00:00:00Z'))
    assert.deepEqual(layout.slice(-5).map((file) => file.split(':')[0]), files)
    assert.equal(copies.length, expectedCopies)
    if (expectedCopies) assert.equal(copies[0].at(-1), `ghcr.io/boxlite-ai/boxlite-plugin:${version}`)
    assert.equal(output, `image=ghcr.io/boxlite-ai/boxlite-plugin\ndigest=sha256:${'a'.repeat(64)}\n`)
  })
}

for (const [fault, expectedCopies] of [
  ['moved-tag', 0],
  ['corrupt-package', 0],
  ['auth-error', 0],
  ['uninitialized-package', 0],
  ['lookup-error', 0],
  ['conflicting-version', 0],
  ['upload-error', 1],
  ['changed-digest', 1],
]) {
  test(`plugin publisher fails without an attestation digest on ${fault}`, (t) => {
    const { run, copies, output } = execute(t, publishScript, fault)
    assert.notEqual(run.status, 0)
    assert.equal(copies.length, expectedCopies)
    assert.equal(output, '')
  })
}
