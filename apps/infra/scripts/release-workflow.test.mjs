import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { load } from 'js-yaml'
import { selectRelease } from './release-selection.mjs'

const readWorkflow = (name) =>
  load(readFileSync(new URL('../../../.github/workflows/' + name + '.yml', import.meta.url), 'utf8'))
const release = readWorkflow('mbuild-release')
const rollout = readWorkflow('mdeploy-all')

test('release deployment is a native dependency in the publisher run', () => {
  const calls = Object.values(release.jobs).filter((job) => job.uses === './.github/workflows/mdeploy-all.yml')
  assert.deepEqual(
    calls.map((job) => job.with.stage).sort(),
    ['dev', 'prod'],
    'release dispatches deployment outside its workflow run',
  )
  assert.ok(release.jobs.dev.needs.includes('publish-runner'))
  assert.ok(release.jobs.prod.needs.includes('dev'))
  assert.equal(rollout.jobs.e2e.uses, './.github/workflows/e2e-cloud.yml')
  assert.ok(rollout.jobs.e2e.needs.includes('plan'))
  assert.equal(rollout.jobs.report, undefined, 'successful acceptance must not allocate a report runner')
})

test('release dev approval uses only the release webhook', () => {
  const inputs = { stage: 'dev', apply: true, release_sha: 'a'.repeat(40) }
  const notices = rollout.jobs.resolve.steps.filter((s) => s.run?.endsWith('release-pipeline.mjs approval'))
  const selected = notices.filter((s) => new Function('inputs', 'return ' + s.if)(inputs))
  assert.deepEqual(
    selected.map((s) => s.env.SLACK_WEBHOOK_URL),
    ['$' + '{{ secrets.SLACK_WEBHOOK_URL }}'],
  )
})

const expression = (value) => value.replace(/^\$\{\{\s*|\s*\}\}$/g, '')

test('standalone and release applies choose exactly one channel, including an unset release webhook', () => {
  const job = rollout.jobs.result
  const steps = job.steps.filter((step) => step.run?.endsWith('release-pipeline.mjs result'))
  for (const step of steps) {
    assert.match(
      expression(step.env.SLACK_WEBHOOK_URL),
      /^secrets\.(SLACK_WEBHOOK_URL|SLACK_DEV_DEPLOYMENT_WEBHOOK_URL)$/,
      'each result step must read one named secret',
    )
  }
  const channel = (inputs, secrets) => {
    const selected = steps.filter((step) => new Function('inputs', 'return ' + expression(step.if))(inputs))
    assert.equal(selected.length, 1)
    return new Function('secrets', 'return ' + expression(selected[0].env.SLACK_WEBHOOK_URL))(secrets)
  }
  const secrets = { SLACK_WEBHOOK_URL: 'release', SLACK_DEV_DEPLOYMENT_WEBHOOK_URL: 'dev' }
  for (const [stage, sha, expected] of [
    ['dev', '', 'dev'],
    ['stage', '', 'dev'],
    ['prod', '', 'release'],
    ['dev', 'sha', 'release'],
    ['prod', 'sha', 'release'],
  ]) {
    assert.equal(channel({ stage, release_sha: sha }, secrets), expected)
  }
  assert.equal(channel({ stage: 'dev', release_sha: 'sha' }, { ...secrets, SLACK_WEBHOOK_URL: '' }), '')
  assert.match(rollout.jobs.result.if, /inputs\.apply/)
  assert.equal(release.jobs.dev.secrets.SLACK_DEV_DEPLOYMENT_WEBHOOK_URL, undefined)
  const outcome = new Function('needs', 'return ' + expression(job.env.DEPLOY_RESULT))
  for (const [version, plan, deploy, expected] of [
    ['v1.2.3', 'success', 'skipped', 'success'],
    ['', 'success', 'failure', 'failure'],
    ['', 'success', 'success', 'success'],
    ['v1.2.3', 'failure', 'skipped', 'failure'],
  ]) {
    assert.equal(
      outcome({
        resolve: { result: 'success', outputs: { version } },
        plan: { result: plan },
        deploy: { result: deploy },
      }),
      expected,
    )
  }
})

test('release admission checks caller, tag, reviewers and deployment attempt before production', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'release-call-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'gh'), '#!/bin/sh\nprintf "%s\\n" "$REVIEWERS"\nexit "${GH_EXIT:-0}"\n', { mode: 0o755 })
  const guard = rollout.jobs.resolve.steps.find((step) => step.name === 'Validate release caller and published commit')
  const repo = 'boxlite-ai/boxlite'
  const base = {
    PATH: dir + ':' + process.env.PATH,
    GITHUB_REPOSITORY: repo,
    GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: repo + '/.github/workflows/mbuild-release.yml@refs/heads/main',
    RESOLVED: 'a'.repeat(40),
    RELEASE_SHA: 'a'.repeat(40),
    VERSION: 'v1.2.3',
    STAGE: 'prod',
    ACCEPTED_ATTEMPT: '2',
    GITHUB_RUN_ATTEMPT: '2',
    REVIEWERS: JSON.stringify({ protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User' }] }] }),
  }
  const run = (script, extra) => spawnSync('bash', ['-c', script], { env: { ...base, ...extra } }).status
  assert.equal(run(guard.run, {}), 0)
  for (const overrides of [
    { GITHUB_WORKFLOW_REF: 'unexpected' },
    { RESOLVED: 'b'.repeat(40) },
    { VERSION: '' },
    { STAGE: 'stage' },
    { REVIEWERS: '{"protection_rules":[]}' },
    { GH_EXIT: '1' },
  ])
    assert.notEqual(run(guard.run, overrides), 0)
  assert.equal(run(guard.run, { STAGE: 'dev', ACCEPTED_ATTEMPT: '', GH_EXIT: '1' }), 0)
  const cloud = readWorkflow('e2e-cloud')
  const e2eGuard = cloud.jobs.e2e.steps.find((step) => step.env?.DEPLOYMENT_ATTEMPT)
  for (const [attempt, sha, expected] of [
    ['2', base.RELEASE_SHA, 0],
    ['1', base.RELEASE_SHA, 1],
    ['2', 'b'.repeat(40), 1],
  ]) {
    assert.equal(
      run(e2eGuard.run, {
        DEPLOYMENT_ATTEMPT: attempt,
        REVIEWERS: sha,
        RELEASE_TAG: base.VERSION,
        GITHUB_OUTPUT: join(dir, 'outputs'),
      }),
      expected,
    )
  }
  const checkout = cloud.jobs.e2e.steps.find(
    (step) => step.name === 'Checkout release SDK sources for subdomain clients',
  )
  assert.equal(
    checkout.env?.RELEASE_SDK_SHA,
    '${{ steps.release_commit.outputs.sha }}',
    'release SDK checkout must use the verified commit',
  )
  const outputs = join(dir, 'standalone-outputs')
  const standalone = { DEPLOYMENT_ATTEMPT: '', RELEASE_SHA: '', RELEASE_TAG: base.VERSION, GITHUB_OUTPUT: outputs }
  assert.notEqual(run(e2eGuard.run, { ...standalone, REVIEWERS: base.VERSION }), 0)
  assert.equal(run(e2eGuard.run, { ...standalone, REVIEWERS: base.RELEASE_SHA }), 0)
  assert.equal(readFileSync(outputs, 'utf8'), 'sha=' + base.RELEASE_SHA + '\n')
})

test('prod may retry a previous attempt only with the exact dev acceptance receipt', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'prod-retry-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(
    join(dir, 'gh'),
    '#!/bin/bash\nset -eu\nmkdir -p "${@: -1}"\ncp "$RECEIPT" "${@: -1}/acceptance.json"\n',
    { mode: 0o755 },
  )
  const sha = 'a'.repeat(40),
    digest = 'sha256:' + 'b'.repeat(64)
  const accepted = { run: 44, attempt: 1, candidate: 77, digest, sha, tag: 'v1.2.3' }
  const env = {
    ...process.env,
    PATH: dir + ':' + process.env.PATH,
    RUNNER_TEMP: dir,
    RECEIPT: join(dir, 'receipt'),
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_RUN_ID: '44',
    GITHUB_REPOSITORY: 'boxlite-ai/boxlite',
    ACCEPTED_ATTEMPT: '1',
    CANDIDATE: '77',
    DIGEST: digest,
    TAG: accepted.tag,
    SHA: sha,
  }
  for (const job of [rollout.jobs.plan, rollout.jobs.resolve]) {
    const guard = job.steps.find((step) => step.name === 'Verify dev acceptance for the production candidate')
    for (const [changed, expected] of [
      [{}, 0],
      [{ candidate: 78 }, 1],
      [{ digest: 'sha256:' + 'c'.repeat(64) }, 1],
      [{ sha: 'd'.repeat(40) }, 1],
      [{ run: 45 }, 1],
      [{ attempt: 3 }, 1],
      [{ tag: 'v1.2.4' }, 1],
    ]) {
      writeFileSync(env.RECEIPT, JSON.stringify({ ...accepted, ...changed }))
      const result = spawnSync('bash', ['-c', guard.run], { env, encoding: 'utf8' })
      assert.equal(result.status === 0, expected === 0, 'receipt ' + JSON.stringify(changed) + ' ' + result.stderr)
    }
  }
})

test('npm preflights all packages before publishing and verifies missing packages in order', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'boxlite-npm-publication-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const tag = 'v1.2.3'
  const platform = '@boxlite-ai/boxlite-linux-x64-gnu@1.2.3'
  const main = '@boxlite-ai/boxlite@1.2.3'
  const record = join(dir, 'published')
  mkdirSync(join(dir, 'package'))
  writeFileSync(record, '')
  for (const id of [platform, main]) {
    const name = id.slice(0, id.lastIndexOf('@'))
    const file = name.slice(1).replace('/', '-') + '-1.2.3.tgz'
    writeFileSync(join(dir, 'package', 'package.json'), JSON.stringify({ name, version: '1.2.3' }))
    execFileSync('tar', ['-czf', file, 'package/package.json'], { cwd: dir })
  }
  writeFileSync(join(dir, 'npm'), [
    '#!/bin/bash',
    'set -euo pipefail',
    'case "$1" in',
    '  view)',
    '    entry="$RUNNER_TEMP/${2##*/}.integrity"',
    '    if [[ ! -f "$entry" ]]; then echo "npm error code E404" >&2; exit 1; fi',
    '    if [[ "${4:-}" == --json ]]; then jq -Rs . < "$entry"; else cat "$entry"; fi ;;',
    '  publish)',
    "    id=$(tar -xOzf \"$2\" package/package.json | jq -r '.name + \"@\" + .version')",
    '    echo "$id" >> "$RUNNER_TEMP/published"',
    '    digest=$(openssl dgst -sha512 -binary "$2" | openssl base64 -A)',
    '    printf %s "${CORRUPT:-sha512-$digest}" > "$RUNNER_TEMP/${id##*/}.integrity" ;;',
    '  *) exit 2 ;;',
    'esac',
  ].join('\n'), { mode: 0o755 })
  const script = release.jobs.npm.steps.find(step => step.name === 'Publish platform packages before the main package').run
  const publish = (extra = {}) => spawnSync('bash', ['-ec', script], {
    cwd: dir, encoding: 'utf8',
    env: { ...process.env, PATH: dir + ':' + process.env.PATH, RELEASE_ASSET_DIR: dir, RUNNER_TEMP: dir, TAG: tag, ...extra },
  })
  const mainEntry = join(dir, 'boxlite@1.2.3.integrity')
  writeFileSync(mainEntry, 'sha512-conflict')
  assert.notEqual(publish().status, 0, 'existing main package conflicts')
  assert.equal(readFileSync(record, 'utf8'), '', 'a later conflict must block even the first platform upload')
  rmSync(mainEntry)
  const first = publish()
  assert.equal(first.status, 0, first.stderr)
  assert.deepEqual(readFileSync(record, 'utf8').trim().split('\n'), [platform, main])
  writeFileSync(record, '')
  const retry = publish()
  assert.equal(retry.status, 0, retry.stderr)
  assert.equal(readFileSync(record, 'utf8'), '', 'matching packages must be reused')
  rmSync(mainEntry)
  assert.notEqual(publish({ CORRUPT: 'sha512-wrong' }).status, 0, 'the registry must report the uploaded digest')
  assert.equal(readFileSync(record, 'utf8').trim(), main)
})

test('PyPI publication rejects conflicting wheels before the upload action can run', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pypi-preflight-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const steps = release.jobs.pypi.steps
  const source = join(dir, 'source'),
    filename = 'boxlite-1.2.3-py3-none-any.whl'
  mkdirSync(source)
  writeFileSync(join(source, filename), 'accepted')
  writeFileSync(
    join(dir, 'curl'),
    '#!/bin/bash\nset -eu\nwhile [[ $# -gt 0 ]]; do if [[ "$1" == "-o" ]]; then cp "$DATA" "$2"; shift; fi; shift; done\nprintf %s "$STATUS"\n',
    { mode: 0o755 },
  )
  const env = {
    ...process.env,
    PATH: dir + ':' + process.env.PATH,
    TAG: 'v1.2.3',
    RELEASE_ASSET_DIR: source,
    DATA: join(dir, 'pypi-response'),
  }
  const select = steps.findIndex((step) => step.name === 'Select accepted wheels')
  const upload = steps.findIndex((step) => step.uses?.startsWith('pypa/'))
  const repo = new URL('../../../', import.meta.url).pathname.replace(/\/$/, '')
  const before = steps
    .slice(select, upload)
    .map((step) => step.run)
    .join('\n')
    .replaceAll('scripts/release/', repo + '/scripts/release/')
  const after = steps[upload + 1].run.replaceAll('scripts/release/', repo + '/scripts/release/')
  function check(script, status, sha) {
    writeFileSync(env.DATA, JSON.stringify({ urls: sha ? [{ filename, digests: { sha256: sha } }] : [] }))
    return spawnSync('bash', ['-ec', script], { cwd: dir, env: { ...env, STATUS: status }, encoding: 'utf8' }).status
  }
  const hash = execFileSync('shasum', ['-a', '256', join(source, filename)], { encoding: 'utf8' }).split(' ')[0]
  for (const [status, sha, allowed, complete] of [
    ['200', '0'.repeat(64), false, false],
    ['200', hash, true, true],
    ['404', '', true, false],
    ['500', '', false, false],
    ['200', '', true, false],
  ]) {
    rmSync(join(dir, 'dist'), { recursive: true, force: true })
    assert.equal(check(before, status, sha) === 0, allowed, 'before publisher ' + status + ' ' + sha)
    assert.equal(check(after, status, sha) === 0, complete, 'after publisher ' + status + ' ' + sha)
  }
})

test('build-only never enters deployment, checks, or reporting; failed E2E cannot stamp acceptance', () => {
  for (const id of ['distribution', 'dev', 'prod']) assert.match(release.jobs[id].if, /needs\.resolve\.outputs\.mode == 'release'/)
  assert.match(release.jobs.report.if, /!inputs\['build-only'\]/)
  assert.equal(rollout.concurrency.group, 'mdeploy-all-${{ inputs.stage }}')
  assert.notEqual(release.concurrency.group, rollout.concurrency.group)
  const outputs = rollout.on.workflow_call.outputs
  const stamp = new Function('jobs', 'return ' + expression(outputs.accepted_attempt.value))
  for (const result of ['failure', 'cancelled', 'skipped', 'success']) {
    assert.equal(
      stamp({
        plan: { result: 'success', outputs: { deployment_attempt: '2' } },
        e2e: { outputs: { release_result: result } },
      }),
      result === 'success' ? '2' : '',
    )
  }
  assert.equal(outputs.e2e_result.value, '${{ jobs.e2e.outputs.release_result }}')
  const cloud = readWorkflow('e2e-cloud')
  assert.equal(cloud.on.workflow_call.outputs.release_result.value, '${{ jobs.e2e.outputs.release_result }}')
  assert.equal(cloud.jobs.e2e.outputs.release_result, '${{ steps.acceptance.outputs.result }}')
  const summary = cloud.jobs.e2e.steps.at(-1)
  assert.equal(summary.id, 'acceptance')
  assert.equal(summary.if, 'always() && inputs.deployment_attempt')
  assert.equal(summary.env.E2E_RESULT, '${{ job.status }}')
  assert.match(release.jobs.report.if, /contains\(needs\.\*\.result, 'failure'\)/)
  assert.match(release.jobs.report.if, /contains\(needs\.\*\.result, 'cancelled'\)/)
  for (const job of ['dev','attach','finalize','pypi','npm','publish_crates']) assert.ok(release.jobs.report.needs.includes(job))
  assert.match(release.jobs.prod.if, /needs\.dev\.outputs\.accepted_attempt != ''/)
})

test('only a prod approval after dev acceptance carries the E2E success', () => {
  const notice = rollout.jobs.resolve.steps.find((step) => step.name === 'Notify release reviewers')
  assert.ok(notice.env.ACCEPTED_TAG, 'prod approval must include the accepted tag')
  const accepted = new Function('inputs', 'return ' + expression(notice.env.ACCEPTED_TAG))
  for (const [stage, attempt, expected] of [
    ['dev', '', ''],
    ['prod', '', ''],
    ['prod', '2', 'v1.2.3'],
  ]) {
    assert.equal(accepted({ stage, accepted_attempt: attempt, ref: 'v1.2.3' }), expected)
  }
})

test('the cloud suite cannot write the default branch cache', () => {
  const cloud = readWorkflow('e2e-cloud')
  assert.ok(
    ['read', 'none'].includes(cloud.jobs.e2e['cache-mode'] || cloud['cache-mode']),
    'E2E needs a read-only cache',
  )
})

test('release SDK worktree uses the verified commit even when the remote has advanced', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cloud-sdk-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const git = (...args) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '-q', 'source')
  const commit = (text) =>
    git(
      '-C',
      'source',
      '-c',
      'user.name=Test',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      text,
    )
  commit('published')
  const sha = git('-C', 'source', 'rev-parse', 'HEAD')
  commit('later change')
  git('init', '-q', 'suite')
  const step = readWorkflow('e2e-cloud').jobs.e2e.steps.find(
    (s) => s.name === 'Checkout release SDK sources for subdomain clients',
  )
  assert.ok(step.run, 'the suite should share its Git object store with the release SDK worktree')
  const run = (ref) =>
    spawnSync('bash', ['-c', step.run], {
      cwd: join(dir, 'suite'),
      encoding: 'utf8',
      env: {
        ...process.env,
        RELEASE_SDK_SHA: ref,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'url.file://' + join(dir, 'source') + '.insteadOf',
        GIT_CONFIG_VALUE_0: 'https://github.com/boxlite-ai/boxlite.git',
      },
    })
  const missing = run('0'.repeat(40))
  assert.notEqual(missing.status, 0)
  const result = run(sha)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(git('-C', 'suite/target/e2e-release', 'rev-parse', 'HEAD'), sha)
  const common = (path) => git('-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir')
  assert.equal(common('suite/target/e2e-release'), common('suite'))
})

test('component repairs use the accepted candidate and package publishers stay in the entry workflow', () => {
  const commands = release.on.workflow_dispatch.inputs.command.options
  assert.deepEqual(commands.filter((name) => name.startsWith('repair-')), ['repair-runtime', 'repair-wheels', 'repair-node', 'repair-c'])
  const locate = release.jobs['accepted-candidate']
  const receipt = locate.steps.find((step) => step.id === 'receipt').run
  assert.match(receipt, /head_branch == "main"/)
  assert.match(receipt, /dev-accepted-\$ID/)
  assert.match(receipt, /\.candidate == \$id and \.run == \$run/)
  const attach = release.jobs.attach
  assert.ok(attach.needs.includes('accepted-candidate'))
  for (const [job, command] of [['npm','repair-node'],['pypi','repair-wheels']]) {
    const publisher=release.jobs[job]
    assert.ok(publisher.needs.includes('attach'))
    assert.equal(publisher.permissions['id-token'],'write')
    assert.ok(publisher.if.includes(command))
    const input=publisher.steps.find((step)=>step.uses==='./.github/actions/release-candidate').with
    assert.equal(input.run,'${{ needs.attach.outputs.run }}')
    assert.equal(input.id,'${{ needs.attach.outputs.candidate }}')
    assert.equal(input.digest,'${{ needs.attach.outputs.digest }}')
  }
  assert.ok(release.jobs.publish_crates.needs.includes('finalize'))
  assert.ok(release.jobs.finalize.if.includes("inputs.command == 'publish'"))
})

test('GHCR pins unlock dev and dev acceptance independently unlocks prod and publication', () => {
  const jobs = release.jobs
  assert.deepEqual(jobs.dev.needs, ['resolve', 'publish', 'publish-runner'], 'dev must prepare as soon as GHCR producers finish')
  assert.equal(jobs.check, undefined)
  const prepare = rollout.jobs.resolve
  const validate = prepare.steps.findIndex((step) => step.run?.includes('release-candidate.mjs deployment'))
  const upload = prepare.steps.findIndex((step) => step.with?.name?.startsWith('deployment-candidate-'))
  const approve = prepare.steps.findIndex((step) => step.name === 'Notify release reviewers')
  const download = prepare.steps.findIndex((step) => step.with?.pattern === 'ghcr-*')
  assert.ok(download >= 0 && download < validate && validate < upload && upload < approve)
  for (const index of [download, validate, upload]) {
    const stageCandidate = new Function('inputs', 'return ' + prepare.steps[index].if)
    assert.ok(stageCandidate({ stage: 'dev', release_sha: 'release-commit' }))
    assert.ok(!stageCandidate({ stage: 'prod', release_sha: 'release-commit' }))
    assert.ok(!stageCandidate({ stage: 'dev' }))
  }
  for (const key of ['candidate_id', 'candidate_digest', 'registry_digests']) {
    assert.equal(rollout.on.workflow_call.outputs[key].value, '$' + '{{ jobs.resolve.outputs.' + key + ' }}')
    assert.equal(jobs.prod.with[key], '$' + '{{ needs.dev.outputs.' + key + ' }}')
  }
  for (const key of ['candidate_id', 'candidate_digest']) {
    assert.equal(rollout.jobs.e2e.with[key], '$' + '{{ needs.resolve.outputs.' + key + ' }}')
  }
  assert.equal(jobs.dev.with.release_images, '$' + '{{ needs.resolve.outputs.artifacts }}')
  assert.equal(prepare.steps[validate].env.IMAGES, '$' + '{{ inputs.release_images }}')
  assert.deepEqual(jobs.prod.needs, ['resolve', 'dev'], 'prod waits for release finalization')
  assert.ok(jobs.attach.needs.includes('dev'))
  assert.ok(jobs.attach.needs.includes('distribution'))
  assert.ok(jobs.attach.needs.includes('build-go'))
  assert.ok(!jobs.attach.needs.includes('prod'))
  assert.ok(jobs.publish_crates.needs.includes('finalize'))
})

test('Go tag stays unpublished until every C SDK can be downloaded anonymously for this public release', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'go-public-c-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const root = new URL('../../../', import.meta.url)
  const tag = 'v1.2.3'
  const goRef = 'refs/tags/sdks/go/' + tag
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init', '--bare', 'origin.git')
  git('init')
  git('-c', 'user.name=Fixture', '-c', 'user.email=ci@example.invalid', '-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-m', 'source')
  const sha = git('rev-parse', 'HEAD')
  git('remote', 'add', 'origin', join(dir, 'origin.git'))
  git('push', 'origin', sha + ':refs/tags/' + tag)
  for (const path of ['apps/infra/scripts/release-candidate.mjs', '.github/ci-config.json']) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    copyFileSync(new URL(path, root), join(dir, path))
  }

  const targets = JSON.parse(readFileSync(new URL('.github/ci-config.json', root))).platforms
  const assets = targets.map(({ target }) => {
    const name = 'boxlite-c-' + tag + '-' + target + '.tar.gz'
    return { name, size: name.length, state: 'uploaded', digest: 'sha256:' + createHash('sha256').update(name).digest('hex') }
  })
  writeFileSync(join(dir, 'gh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  "api repos/boxlite-ai/boxlite/releases/123") cat "$FIXTURE/release.json" ;;',
    '  *"/releases/123/assets?per_page=100") cat "$FIXTURE/assets.json" ;;',
    '  *) exit 2 ;;',
    'esac',
  ].join('\n'), { mode: 0o755 })
  writeFileSync(join(dir, 'public-fetch.mjs'), `
    globalThis.fetch = async (url, options) => {
      const request = new Request(url, options)
      const base = 'https://github.com/boxlite-ai/boxlite/releases/download/v1.2.3/'
      if (!request.url.startsWith(base) || request.method !== 'GET' || request.headers.has('authorization')) throw Error('unexpected request')
      const name = request.url.slice(base.length)
      if (name === process.env.UNAVAILABLE) return new Response(null, { status: 404 })
      return new Response(name === process.env.CORRUPT ? 'wrong bytes' : name)
    }
  `)
  const steps = release.jobs['tag-go-module'].steps.filter(step => step.run).map(step => step.run)
  function publish({ draft = false, files = assets, ...extra } = {}) {
    writeFileSync(join(dir, 'release.json'), JSON.stringify({ tag_name: tag, draft }))
    writeFileSync(join(dir, 'assets.json'), JSON.stringify([files]))
    return spawnSync('bash', ['-ec', steps.join('\n')], { cwd: dir, encoding: 'utf8',
      env: { ...process.env, FIXTURE: dir, PATH: dir + ':' + process.env.PATH, GITHUB_REPOSITORY: 'boxlite-ai/boxlite',
        TAG: tag, RELEASE_TAG: tag, RELEASE_ID: '123', C_SHA: sha, NODE_OPTIONS: '--import=' + join(dir, 'public-fetch.mjs'), ...extra },
    })
  }
  for (const [reason, options] of [
    ['draft', { draft: true }], ['missing asset', { files: assets.slice(1) }],
    ['anonymous 404', { UNAVAILABLE: assets.at(-1).name }], ['wrong bytes', { CORRUPT: assets[0].name }],
  ]) {
    const result = publish(options)
    assert.equal(git('ls-remote', '--refs', 'origin', goRef), '', 'Go tag was pushed for ' + reason)
    assert.notEqual(result.status, 0, reason)
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = publish()
    assert.equal(result.status, 0, result.stderr)
    assert.equal(git('ls-remote', '--refs', 'origin', goRef), sha + '\t' + goRef)
  }
})

test('publication gates accept a skipped optional ancestor and require successful direct prerequisites', () => {
  for (const [id, prerequisites, commands] of [
    ['npm', ['attach'], ['publish', 'publish-node', 'repair-node']],
    ['pypi', ['attach'], ['publish', 'publish-wheels', 'repair-wheels']],
    ['tag-go-module', ['finalize'], ['publish', 'publish-go']],
    ['finalize', ['npm', 'pypi', 'attach'], ['publish']],
    ['publish_crates', ['finalize'], ['publish', 'publish-runtime']],
  ]) {
    const condition = expression(release.jobs[id].if)
    const evaluate = new Function('github', 'inputs', 'needs', 'cancelled', 'contains', 'fromJSON',
      'return ' + condition.replace(/needs\.([\w]+-[\w-]+)/g, "needs['$1']"))
    const needs = Object.fromEntries(release.jobs[id].needs.map((name) => [name, { result: 'success' }]))
    needs.resolve.outputs = { public_release: 'true' }
    const selected = (command, cancelled = false, ref = 'refs/heads/main') => {
      // GitHub implicitly adds success() when the condition omits a status function.
      if (!/\b(success|failure|always|cancelled)\(/.test(condition)) return false
      return evaluate({ ref }, { command }, needs, () => cancelled, (a, b) => a.includes(b), JSON.parse)
    }
    for (const command of release.on.workflow_dispatch.inputs.command.options) {
      assert.equal(selected(command), commands.includes(command), id + ' on ' + command)
    }
    for (const name of prerequisites) {
      needs[name] ??= { result: 'success' }
      for (const result of ['skipped', 'failure', 'cancelled']) {
        needs[name].result = result
        assert.equal(selected('publish'), false, id + ' after ' + name + ' ' + result)
      }
      needs[name].result = 'success'
    }
    assert.equal(selected('publish', true), false)
    assert.equal(selected('publish', false, 'refs/heads/topic'), false)
  }
})

test('single components select their producers and bypass rollout, including with skipped sibling jobs', () => {
  for (const [component, group] of Object.entries({ runtime: 'runtime-distribution', wheels: 'wheels-', node: 'node-packages', c: 'c-sdk-', go: '', runner: 'runner-linux-amd64' })) {
    const command = 'publish-' + component
    for (const buildOnly of [true, false]) {
      const selection = selectRelease(command, buildOnly, '', '')
      assert.equal(selection.group, group)
      const needs = Object.fromEntries(Object.keys(release.jobs).map(id => [id, { result: 'skipped', outputs: {} }]))
      needs.resolve = { result: 'success', outputs: { ...selection, builds: JSON.stringify(selection.builds) } }
      const allows = id => {
        const job = release.jobs[id]
        const deps = [job.needs || []].flat()
        const condition = expression(job.if).replaceAll('needs.*.result', 'results').replace(/needs\.([\w]+-[\w-]+)/g, "needs['$1']")
        const statuses = deps.map(dep => needs[dep].result)
        if (!condition.includes('cancelled()') && statuses.some(result => result !== 'success')) return false
        const evaluate = new Function('needs','results','inputs','github','contains','fromJSON','cancelled','return ' + condition)
        return Boolean(evaluate(needs, statuses, { command, 'build-only': buildOnly }, { ref: 'refs/heads/main' }, (a,b) => a.includes(b), JSON.parse, () => false))
      }
      const enabled = []
      for (const id of ['build-runtime','build-wheels','build-node','build-c','build-go','build-runner-binary','publish','publish-runner','distribution','accepted-candidate','dev','attach','npm','pypi','prod','finalize','tag-go-module','publish_crates']) {
        if (allows(id)) { enabled.push(id); needs[id].result = 'success' }
      }
      const expected = ['go','runner'].includes(component) ? ['build-c'] : []
      expected.push(component === 'runner' ? 'build-runner-binary' : 'build-' + component)
      if (!buildOnly) {
        if (component === 'runner') expected.push('publish-runner')
        if (group) expected.push('distribution','attach')
        if (component === 'node') expected.push('npm')
        if (component === 'wheels') expected.push('pypi')
        if (component === 'go') expected.push('tag-go-module')
      }
      assert.deepEqual(enabled, expected, command + ' build-only=' + buildOnly)
      if (!buildOnly && group) {
        needs[selection.producer].result = 'failure'
        assert.equal(allows('distribution'), false, 'failed ' + component + ' must block publication')
      }
      if (!buildOnly && component === 'runtime') {
        needs.resolve.outputs.public_release = 'true'
        assert.equal(allows('publish_crates'), true)
      }
    }
  }
  assert.throws(() => selectRelease('publish-c', false, '', 'feature'))
  assert.throws(() => selectRelease('repair-node', false, '', ''))
  assert.throws(() => selectRelease('publish-runner', false, '3', ''))
})
