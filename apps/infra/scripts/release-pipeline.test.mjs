import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { runnerArtifactFor } from '../mdeploy/stack/runner-binary.ts'
import { ReleasePipeline, releaseAssets, releaseReport, sendSlack, slackWebhook } from './release-pipeline.mjs'

const snapshot = JSON.parse(readFileSync(new URL('./fixtures/release-v0.13.1-assets.json', import.meta.url), 'utf8'))
const repo = 'boxlite-ai/boxlite'
const displayTitle = 'deploy dev · <@requested_by> · <!channel> & review'
const tag = snapshot.tag_name
const webhook = 'https://hooks.slack.com/services/Tfixture/Bfixture/private-fixture-token'
const root = new URL('../../../', import.meta.url)
const e2eWorkflow = load(readFileSync(new URL('.github/workflows/e2e-cloud.yml', root), 'utf8'))
const json = (value, status = 200) => new Response(JSON.stringify(value), { status })

const harness = (options = {}) => {
  const calls = [],
    logs = [],
    waits = []
  let now = 0,
    assetReads = 0
  const request = async (url, init) => {
    const req = new Request(url, init)
    const path = new URL(req.url).pathname + new URL(req.url).search
    const call = {
      path,
      method: req.method,
      headers: req.headers,
      redirect: init.redirect,
      body: init.body ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    const overridden = options.respond?.(call)
    if (overridden) return overridden
    if (path.includes('/releases/tags/')) return json(snapshot)
    if (path.includes('/assets?')) return json(options.assets?.(++assetReads, path) ?? snapshot.assets)
    throw new Error('Unexpected test request: ' + path)
  }
  const client = new ReleasePipeline({
    repo,
    tag,
    token: 'fixture-token',
    request,
    timer: {
      now: () => now,
      wait: async (delay) => {
        waits.push(delay)
        now += options.advance ?? delay
      },
    },
    log: (message) => logs.push(message),
  })
  return { client, calls, logs, waits }
}

const cliHarness = (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'boxlite-release-cli-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const preload = join(directory, 'transport.mjs')
  writeFileSync(
    preload,
    [
      "import { appendFileSync } from 'node:fs'",
      'const responses = JSON.parse(process.env.RELEASE_TEST_RESPONSES)',
      'globalThis.fetch = async (url, init) => {',
      '  const address = new URL(url)',
      '  const body = init.body ? JSON.parse(init.body) : undefined',
      "  appendFileSync(process.env.RELEASE_TEST_REQUESTS, JSON.stringify({ url, method: init.method, body }) + '\\n')",
      "  if (address.hostname === 'hooks.slack.com') return new Response('ok', { status: Number(process.env.SLACK_TEST_STATUS || 200) })",
      "  if (address.pathname.endsWith('/actions/runs/10')) return Response.json({ id: 10, display_title: process.env.TEST_TITLE }, { status: Number(process.env.TITLE_TEST_STATUS || 200) })",
      "  if (address.hostname !== 'api.github.com') throw new Error('Unexpected test host')",
      '  const value = responses[address.pathname]',
      "  if (value === undefined) throw new Error('Unexpected test endpoint')",
      '  return Response.json(value)',
      '}',
    ].join('\n'),
  )
  const prefix = '/repos/' + repo
  const responses = {
    [prefix + '/releases/tags/' + tag]: snapshot,
    [prefix + '/releases/' + snapshot.id + '/assets']: snapshot.assets,
  }
  return (command, overrides = {}) => {
    const output = join(directory, 'output')
    const summary = join(directory, 'summary')
    const requests = join(directory, 'requests')
    for (const file of [output, summary, requests]) writeFileSync(file, '')
    const result = spawnSync(
      process.execPath,
      ['--import', preload, fileURLToPath(new URL('./release-pipeline.mjs', import.meta.url)), command],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          GITHUB_REPOSITORY: repo,
          GITHUB_RUN_ID: '10',
          GITHUB_WORKFLOW: 'mbuild-release',
          GITHUB_ACTOR: 'github-actor',
          TEST_TITLE: displayTitle,
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          TAG: tag,
          GH_TOKEN: 'fixture-token',
          SLACK_WEBHOOK_URL: webhook,
          RELEASE_RESULTS: '{}',
          RELEASE_TEST_RESPONSES: JSON.stringify(responses),
          RELEASE_TEST_REQUESTS: requests,
          ...overrides,
        },
      },
    )
    return {
      ...result,
      output: readFileSync(output, 'utf8'),
      summary: readFileSync(summary, 'utf8'),
      requests: readFileSync(requests, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
    }
  }
}

test('deployment CLI identifies the sender, approval batch and current run', (t) => {
  const cli = cliHarness(t)
  const env = {
    GITHUB_WORKFLOW: 'mdeploy-all',
    DEPLOY_ENVIRONMENT: 'dev',
    APPROVAL_PHASE: 'Commit preparation approval',
  }
  const result = cli('approval', env)
  assert.equal(result.status, 0, result.stderr)
  const message = result.requests.find((r) => r.url === webhook).body
  assert.equal(message.blocks.at(-1).elements[0].url, 'https://github.com/' + repo + '/actions/runs/10')
  const fields = message.blocks.flatMap((b) => b.fields ?? [])
  for (const value of [env.GITHUB_WORKFLOW, env.DEPLOY_ENVIRONMENT, env.APPROVAL_PHASE, 'github-actor', displayTitle]) {
    assert.ok(fields.some((f) => f.type === 'plain_text' && f.text.endsWith('\n' + value)))
  }
  const disabled = cli('approval', { ...env, SLACK_WEBHOOK_URL: '' })
  assert.equal(disabled.status, 0, disabled.stderr)
  assert.deepEqual(disabled.requests, [])
})

test('required assets agree with the real Release snapshot and production consumers', () => {
  const required = releaseAssets(tag)
  assert.ok(
    required.every((name) => snapshot.assets.some((asset) => asset.name === name)),
    snapshot.source,
  )
  const runner = runnerArtifactFor({ selector: { kind: 'release', version: tag.slice(1) } })
  assert.ok(required.includes(runner.tarballName))
  assert.ok(required.includes(new URL(runner.checksumUrl).pathname.split('/').at(-1)))
  const installer = readFileSync(new URL('scripts/ci/install-e2e-release.sh', root), 'utf8')
  const python = e2eWorkflow.jobs.e2e.steps.find((step) => step.name === 'Setup Python for release wheel').with[
    'python-version'
  ]
  const variables = { tag, version: tag.slice(1), abi: 'cp' + python.replace('.', '') }
  const downloads = [...installer.matchAll(/^\s*(?:wheel|package|platform|archive)="([^"]+)"/gm)].map((match) =>
    match[1].replace(/\$\{(\w+)\}/g, (_, name) => variables[name]),
  )
  assert.equal(downloads.length, 4)
  for (const name of downloads) assert.ok(required.includes(name), name)
})

test('availability is based on uploaded, nonempty assets from the requested tag', async () => {
  const pending = structuredClone(snapshot.assets)
  pending.find((asset) => asset.name === 'install.sh').state = 'starter'
  const h = harness({ assets: (read) => (read === 1 ? pending : snapshot.assets) })
  await h.client.waitForAssets()
  assert.equal(h.waits.length, 1)
  assert.match(h.logs[0], /install.sh/)
  assert.ok(h.calls[0].path.endsWith('/releases/tags/' + tag))
  assert.ok(h.calls.every((call) => call.method === 'GET'))
})

test('missing and empty assets time out with the missing filename', async () => {
  for (const missing of ['install.sh', 'boxlite-runner-' + tag + '-linux-amd64.tar.gz.sha256']) {
    const h = harness({
      advance: 3 * 60 * 60 * 1000,
      assets: () => snapshot.assets.map((asset) => (asset.name === missing ? { ...asset, size: 0 } : asset)),
    })
    await assert.rejects(
      h.client.waitForAssets(),
      (error) => error.message.includes('Timed out') && error.message.includes(missing),
    )
    assert.equal(h.waits.length, 1)
  }
})

test('asset pagination reads beyond the first page', async () => {
  const h = harness({
    assets: (_, path) =>
      path.endsWith('page=1')
        ? Array.from({ length: 100 }, (_, index) => ({ name: 'other-' + index, size: 1, state: 'uploaded' }))
        : snapshot.assets,
  })
  await h.client.waitForAssets()
  assert.ok(h.calls.some((call) => call.path.endsWith('page=2')))
})

test('asset authentication and malformed responses are failures, not absence', async () => {
  for (const response of [json({}, 403), json({ unexpected: true })]) {
    const h = harness({ respond: (call) => (call.path.includes('/assets?') ? response.clone() : undefined) })
    await assert.rejects(h.client.waitForAssets(), /HTTP 403|Malformed/)
    assert.equal(h.waits.length, 0)
  }
})

test('null release responses are classified as malformed API data', async () => {
  const h = harness({ respond: (call) => (call.path.includes('/releases/tags/') ? json(null) : undefined) })
  await assert.rejects(h.client.waitForAssets(), /Malformed GitHub JSON/)
})

test('Slack payloads are JSON, while HTTP and transport failures do not expose webhook secrets', async () => {
  const payload = releaseReport({ repo, tag, runId: '10', results: {} }).payload
  await sendSlack(webhook, payload, async (url, init) => {
    assert.equal(url, webhook)
    assert.deepEqual(JSON.parse(init.body), payload)
    assert.equal(init.redirect, 'error')
    return new Response('ok')
  })
  for (const request of [
    async () => new Response('private provider body', { status: 500 }),
    async () => {
      throw new Error('transport failed at ' + webhook)
    },
  ]) {
    await assert.rejects(sendSlack(webhook, payload, request), (error) => {
      assert.match(error.message, /Slack notification failed/)
      assert.doesNotMatch(error.message, /private-fixture-token|private provider body/)
      return true
    })
  }
  for (const value of [
    '',
    'http://hooks.slack.com/services/T/B/token',
    'https://example.com/services/T/B/token',
    'https://hooks.slack.com.evil.example/services/T/B/token',
    'https://evil.example/hooks.slack.com/services/T/B/token',
    'https://hooks.slack.com@evil.example/services/T/B/token',
    'https://user:password@hooks.slack.com/services/T/B/token',
    webhook + '?token=private',
  ]) {
    assert.throws(() => slackWebhook(value), /SLACK_WEBHOOK_URL/)
  }
})

test('prod review combines dev E2E success with the approval button; failed acceptance has its own report', (t) => {
  const cli = cliHarness(t)
  const approval = cli('approval', {
    DEPLOY_ENVIRONMENT: 'prod',
    APPROVAL_PHASE: 'Release deployment approval',
    ACCEPTED_TAG: tag,
  })
  const messages = approval.requests.filter((req) => req.url === webhook)
  assert.equal(messages.length, 1)
  assert.match(messages[0].body.text, /dev E2E passed/i)
  assert.ok(messages[0].body.text.includes(tag))
  const button = messages[0].body.blocks.at(-1).elements[0]
  assert.equal(button.text.text, 'Review prod deployment')
  assert.equal(button.url, 'https://github.com/' + repo + '/actions/runs/10')
  for (const outcome of ['failure', 'cancelled', 'skipped']) {
    const results = {
      resolve: { result: 'success' },
      publish: { result: 'success' },
      check: { result: 'success' },
      dev: { result: 'failure', outputs: { e2e_result: outcome } },
    }
    const response = cli('report', { RELEASE_RESULTS: JSON.stringify(results) })
    assert.equal(response.status, 0, response.stderr)
    assert.ok(response.summary.includes('| E2E cloud | ' + outcome + ' |'))
    const message = response.requests.find((req) => req.url === webhook).body
    assert.equal(message.blocks.at(-1).elements[0].url, 'https://github.com/' + repo + '/actions/runs/10')
    assert.equal(message.blocks.at(-1).elements[0].text.text, 'View run logs')
    assert.ok(message.blocks.some((block) => block.fields?.some((field) => field.text === 'E2E cloud\n' + outcome)))
  }
  const preflight = cli('report', {
    RELEASE_RESULTS: JSON.stringify({
      resolve: { result: 'success' },
      publish: { result: 'success' },
      check: { result: 'failure' },
      dev: { result: 'skipped' },
    }),
  })
  const preflightButton = preflight.requests.find((r) => r.url === webhook).body.blocks.at(-1).elements[0]
  assert.equal(preflightButton.text.text, 'View run logs')
  assert.equal(preflightButton.url, 'https://github.com/' + repo + '/actions/runs/10')
  const missing = cli('report', { SLACK_WEBHOOK_URL: '' })
  assert.equal(missing.status, 0)
  assert.deepEqual(missing.requests, [])
  const failed = cli('report', { SLACK_TEST_STATUS: '503' })
  assert.equal(failed.status, 1)
  assert.match(failed.summary, /Release assets/)
})

test('deployment success and failure notifications link to the run and render the ref as plain text', (t) => {
  const cli = cliHarness(t)
  for (const result of ['success', 'failure']) {
    const response = cli('result', { DEPLOY_ENVIRONMENT: 'stage', DEPLOY_REF: '#123', DEPLOY_RESULT: result })
    assert.equal(response.status, 0, response.stderr)
    const message = response.requests.find((req) => req.url === webhook).body
    assert.equal(
      message.blocks.at(-1).elements[0].text.text,
      result === 'failure' ? 'View run logs' : 'View deployment run',
    )
    assert.equal(message.text, 'stage deployment: ' + result)
    assert.deepEqual(message.blocks.at(-2).text, { type: 'plain_text', text: 'Ref: #123' })
    assert.equal(message.blocks.at(-1).elements[0].url, 'https://github.com/' + repo + '/actions/runs/10')
  }
})

test('asset preflight rejects an invalid webhook before reading GitHub and works without Slack', (t) => {
  const cli = cliHarness(t)
  const invalid = cli('assets', { SLACK_WEBHOOK_URL: 'malformed' })
  assert.equal(invalid.status, 1)
  assert.deepEqual(invalid.requests, [])
  const assets = cli('assets', { SLACK_WEBHOOK_URL: '' })
  assert.equal(assets.status, 0, assets.stderr)
  assert.equal(assets.requests.length, 2)
})
