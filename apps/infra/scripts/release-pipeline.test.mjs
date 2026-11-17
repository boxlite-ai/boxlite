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
const tag = snapshot.tag_name
const sha = '6c5855a654beb3ba952faceb9665b5c563770859'
const webhook = 'https://hooks.slack.com/services/Tfixture/Bfixture/private-fixture-token'
const root = new URL('../../../', import.meta.url)
const workflow = load(readFileSync(new URL('.github/workflows/mbuild-release.yml', root), 'utf8'))
const e2eWorkflow = load(readFileSync(new URL('.github/workflows/e2e-cloud.yml', root), 'utf8'))
const run = (runId, values = {}) => ({
  id: runId,
  run_attempt: 1,
  status: 'completed',
  conclusion: 'success',
  display_title: 'deploy dev · ' + tag + ' · api+runner',
  created_at: '2026-11-17T07:00:00Z',
  run_started_at: '2026-11-17T07:00:00Z',
  updated_at: '2026-11-17T07:10:00Z',
  ...values,
})
const json = (value, status = 200) => new Response(JSON.stringify(value), { status })

const harness = (options = {}) => {
  const calls = [],
    records = {},
    logs = [],
    waits = []
  let now = 0,
    assetReads = 0
  const dev = run(101, options.dev)
  const e2e = run(202, {
    created_at: '2026-11-17T07:11:00Z',
    run_started_at: '2026-11-17T07:11:00Z',
    updated_at: '2026-11-17T07:20:00Z',
    ...options.e2e,
  })
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
    if (path.includes('/commits/')) return json({ sha: options.sha ?? sha })
    if (path.includes('/releases/tags/')) return json(snapshot)
    if (path.includes('/assets?')) return json(options.assets?.(++assetReads, path) ?? snapshot.assets)
    if (req.method === 'POST' && path.endsWith('/dispatches')) {
      return json({ workflow_run_id: path.includes('e2e-cloud') ? 202 : call.body.inputs.stage === 'prod' ? 303 : 101 })
    }
    if (path.endsWith('/actions/runs/101')) return json(options.devRead?.() ?? dev)
    if (path.endsWith('/actions/runs/202')) return json(e2e)
    if (path.includes('/attempts/')) {
      const attempt = Number(path.split('/').at(-1))
      return json(options.attempts?.[attempt])
    }
    if (path.includes('/mdeploy-all.yml/runs?')) {
      const page = Number(new URL(req.url).searchParams.get('page'))
      return json({ workflow_runs: options.history?.(page) ?? [dev, ...(options.others ?? [])] })
    }
    if (path.endsWith('/environments/prod')) {
      return json({
        protection_rules:
          options.reviewers === false
            ? []
            : [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: 1 } }] }],
      })
    }
    throw new Error('Unexpected test request: ' + path)
  }
  const client = new ReleasePipeline({
    repo,
    tag,
    sha,
    token: 'fixture-token',
    request,
    timer: {
      now: () => now,
      wait: async (delay) => {
        waits.push(delay)
        now += options.advance ?? delay
      },
    },
    record: (name, value) => {
      records[name] = String(value)
    },
    log: (message) => logs.push(message),
  })
  return { client, calls, records, logs, waits, dev, e2e }
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
      "  if (address.hostname === 'hooks.slack.com') return new Response('ok')",
      "  if (address.hostname !== 'api.github.com') throw new Error('Unexpected test host')",
      "  if (init.method === 'POST' && address.pathname.endsWith('/dispatches')) {",
      '    return Response.json({ workflow_run_id: body.inputs.stage === "prod" ? 303 : body.inputs.tag ? 202 : 101 })',
      '  }',
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
    [prefix + '/commits/' + encodeURIComponent('refs/tags/' + tag)]: { sha },
    [prefix + '/actions/runs/101']: run(101),
    [prefix + '/actions/runs/202']: run(202, { updated_at: '2026-11-17T07:20:00Z' }),
    [prefix + '/actions/workflows/mdeploy-all.yml/runs']: { workflow_runs: [run(101)] },
    [prefix + '/environments/prod']: {
      protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: 1 } }] }],
    },
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
          GITHUB_OUTPUT: output,
          GITHUB_STEP_SUMMARY: summary,
          TAG: tag,
          RELEASE_SHA: sha,
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

test('workflow CLI waits for assets, records child runs, and reports their prod approval link', (t) => {
  const cli = cliHarness(t)
  const assets = cli('assets')
  assert.equal(assets.status, 0, assets.stderr)
  assert.equal(assets.requests.length, 2)
  const pipeline = cli('run')
  assert.equal(pipeline.status, 0, pipeline.stderr)
  const outputs = Object.fromEntries(
    pipeline.output
      .trim()
      .split('\n')
      .map((line) => line.split('=')),
  )
  assert.deepEqual(outputs, {
    dev_run_id: '101',
    dev_result: 'success',
    e2e_run_id: '202',
    e2e_result: 'success',
    prod_run_id: '303',
  })
  const dispatches = pipeline.requests.filter((request) => request.method === 'POST')
  assert.equal(dispatches.length, 3)
  for (const request of dispatches) assert.equal(request.body.inputs.ref ?? request.body.inputs.tag, tag)
  const report = cli('report', {
    RELEASE_RESULTS: JSON.stringify({ pipeline: { result: 'success', outputs } }),
  })
  assert.equal(report.status, 0, report.stderr)
  assert.match(report.summary, /Prod run: https:\/\/github.com\/boxlite-ai\/boxlite\/actions\/runs\/303/)
  assert.equal(report.requests.length, 1)
  const actions = report.requests[0].body.blocks.find((block) => block.type === 'actions')
  assert.equal(actions.elements[0].url, 'https://github.com/' + repo + '/actions/runs/' + outputs.prod_run_id)
})

test('workflow CLI rejects invalid configuration without network calls and preserves a failed report summary', (t) => {
  const cli = cliHarness(t)
  for (const [command, overrides, error] of [
    ['assets', { SLACK_WEBHOOK_URL: '' }, /SLACK_WEBHOOK_URL/],
    ['unknown', {}, /Expected assets, run, or report/],
    ['run', { TAG: 'main' }, /TAG must be/],
    ['run', { GH_TOKEN: '' }, /GH_TOKEN is required/],
    ['report', { SLACK_WEBHOOK_URL: '' }, /SLACK_WEBHOOK_URL/],
  ]) {
    const result = cli(command, overrides)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, error)
    assert.equal(result.requests.length, 0)
    if (command === 'report') assert.match(result.summary, /release pipeline failed/)
  }
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

test('full pipeline dispatches exact child IDs and preserves the release across dev, E2E and prod', async () => {
  let reads = 0
  const h = harness({
    devRead: () => (++reads === 1 ? run(101, { status: 'in_progress', conclusion: null }) : run(101)),
  })
  await h.client.run()
  const posts = h.calls.filter((call) => call.method === 'POST')
  assert.deepEqual(
    posts.map((call) => call.body),
    [
      { ref: 'main', inputs: { stage: 'dev', components: 'api+runner', ref: tag, apply: true, confirm: true } },
      { ref: 'main', inputs: { stage: 'dev', tag } },
      { ref: 'main', inputs: { stage: 'prod', components: 'api+runner', ref: tag, apply: true, confirm: true } },
    ],
  )
  assert.deepEqual(h.records, {
    dev_run_id: '101',
    dev_result: 'success',
    e2e_run_id: '202',
    e2e_result: 'success',
    prod_run_id: '303',
  })
  assert.equal(h.waits.length, 1)
  assert.ok(!h.calls.some((call) => call.path.endsWith('/actions/runs/303')))
  assert.ok(!h.calls.some((call) => call.path.includes('pending_deployments')))
  assert.ok(
    h.calls.every((call) => call.headers.get('X-GitHub-Api-Version') === '2026-03-10' && call.redirect === 'error'),
  )
  const envRead = h.calls.findIndex((call) => call.path.endsWith('/environments/prod'))
  assert.ok(envRead > h.calls.findIndex((call) => call.path.endsWith('/actions/runs/202')))
  assert.ok(envRead < h.calls.indexOf(posts[2]))
})

test('failed and cancelled dev runs stop before E2E or prod dispatch', async () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out']) {
    const h = harness({ dev: { conclusion } })
    await assert.rejects(h.client.run(), /dev run 101 ended/)
    assert.equal(h.calls.filter((call) => call.method === 'POST').length, 1)
    assert.equal(h.records.dev_run_id, '101')
    assert.equal(h.records.dev_result, conclusion)
  }
})

test('failed E2E never requests a prod run', async () => {
  const h = harness({ e2e: { conclusion: 'failure' } })
  await assert.rejects(h.client.run(), /e2e run 202 ended/)
  assert.equal(h.calls.filter((call) => call.method === 'POST').length, 2)
  assert.equal(h.records.e2e_run_id, '202')
  assert.equal(h.records.prod_run_id, undefined)
})

test('deployment and E2E deadlines stop dispatching without cancelling children', async () => {
  for (const [options, name, expectedPosts] of [
    [{ dev: { status: 'waiting', conclusion: null }, advance: 3 * 60 * 60 * 1000 }, 'dev', 1],
    [{ e2e: { status: 'in_progress', conclusion: null }, advance: 60 * 60 * 1000 }, 'e2e', 2],
  ]) {
    const h = harness(options)
    await assert.rejects(h.client.run(), new RegExp('Timed out waiting for ' + name + ' run'))
    assert.equal(h.calls.filter((call) => call.method === 'POST').length, expectedPosts)
    assert.equal(h.records.prod_run_id, undefined)
    assert.ok(h.records[name + '_run_id'])
    assert.equal(h.waits.length, 1)
    assert.ok(!h.calls.some((call) => call.path.endsWith('/cancel')))
  }
})

test('uncertain dispatch responses are not retried or replaced with the latest run', async () => {
  for (const response of [new Response(null, { status: 204 }), json({ workflow_run_id: 0 }), json({}, 503)]) {
    const h = harness({ respond: (call) => (call.method === 'POST' ? response.clone() : undefined) })
    await assert.rejects(h.client.run(), /unknown|valid run ID/)
    assert.equal(h.calls.filter((call) => call.method === 'POST').length, 1)
    assert.ok(!h.calls.some((call) => call.path.includes('/runs?')))
  }
})

test('tag movement before downstream dispatch is rejected', async () => {
  const h = harness({ sha: 'a'.repeat(40) })
  await assert.rejects(h.client.run(), /tag moved/)
  assert.ok(!h.calls.some((call) => call.method === 'POST'))
})

test('prod creation requires a reviewer rule and readable Environment configuration', async () => {
  for (const options of [
    { reviewers: false },
    { respond: (call) => (call.path.endsWith('/environments/prod') ? json({}, 403) : undefined) },
  ]) {
    const h = harness(options)
    await assert.rejects(h.client.run(), /reviewers|HTTP 403/)
    assert.equal(h.calls.filter((call) => call.method === 'POST').length, 2)
    assert.equal(h.records.prod_run_id, undefined)
  }
})

test('failed and cancelled overlapping dev applies invalidate acceptance', async () => {
  for (const conclusion of ['success', 'failure', 'cancelled']) {
    const h = harness({ others: [run(99, { conclusion, updated_at: '2026-11-17T07:15:00Z' })] })
    await assert.rejects(h.client.run(), /overlapped/)
    assert.equal(h.records.prod_run_id, undefined)
  }
})

test('reruns are checked by attempt timing even when the run was created earlier', async () => {
  const previous = run(99, {
    created_at: '2026-10-01T07:00:00Z',
    run_started_at: '2026-11-17T07:15:00Z',
    updated_at: '2026-11-17T07:18:00Z',
    run_attempt: 2,
  })
  const h = harness({
    others: [previous],
    attempts: {
      1: { ...previous, run_started_at: '2026-10-01T07:00:00Z', updated_at: '2026-10-01T07:10:00Z' },
      2: previous,
    },
  })
  await assert.rejects(h.client.run(), /overlapped/)
  assert.ok(h.calls.some((call) => call.path.endsWith('/actions/runs/99/attempts/2')))
})

test('missing attempt timing and truncated history fail closed', async () => {
  const unknown = harness({ others: [run(99, { run_started_at: null, updated_at: '2026-11-17T07:15:00Z' })] })
  await assert.rejects(unknown.client.run(), /attempt timing/)
  const truncated = harness({
    history: () => Array.from({ length: 100 }, (_, index) => run(1000 + index, { updated_at: '2026-11-16T07:10:00Z' })),
  })
  await assert.rejects(truncated.client.run(), /truncated/)
  assert.equal(truncated.records.prod_run_id, undefined)
})

test('a manual rerun of this pipeline dev run also invalidates its validation interval', async () => {
  const rerun = run(101, {
    run_attempt: 2,
    run_started_at: '2026-11-17T07:15:00Z',
    updated_at: '2026-11-17T07:18:00Z',
  })
  const h = harness({
    history: () => [rerun],
    attempts: { 1: run(101), 2: rerun },
  })
  await assert.rejects(h.client.run(), /overlapped/)
  assert.equal(h.records.prod_run_id, undefined)
})

test('null release responses are classified as malformed API data', async () => {
  const h = harness({ respond: (call) => (call.path.includes('/releases/tags/') ? json(null) : undefined) })
  await assert.rejects(h.client.waitForAssets(), /Malformed GitHub JSON/)
})

test('previews, manual prod requests and completed earlier applies do not invalidate dev acceptance', async () => {
  const h = harness({
    others: [
      run(99, {
        display_title: 'preview dev · ' + tag + ' · api',
        updated_at: '2026-11-17T07:15:00Z',
        run_started_at: null,
      }),
      run(98, { display_title: 'deploy prod · ' + tag + ' · api', status: 'waiting', run_started_at: null }),
      run(97, { updated_at: '2026-11-17T07:09:59Z' }),
    ],
  })
  await h.client.run()
  assert.equal(h.records.prod_run_id, '303')
})

test('workflow build-only gates preserve publication and disable every downstream job', () => {
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).sort(), ['build-only', 'command', 'tag'])
  assert.deepEqual(workflow.on.workflow_dispatch.inputs['build-only'], {
    description: 'Build and upload only; skip deployment, E2E and Slack reporting',
    required: true,
    default: false,
    type: 'boolean',
  })
  for (const name of ['publish', 'assets', 'pipeline', 'report']) {
    const expression = workflow.jobs[name].if.replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    const evaluate = new Function('inputs', 'github', 'always', 'return (' + expression + ')')
    for (const buildOnly of [true, false]) {
      assert.equal(
        evaluate({ command: 'publish', 'build-only': buildOnly }, { ref: 'refs/heads/main' }, () => true),
        name === 'publish' || !buildOnly,
        name,
      )
    }
  }
  assert.deepEqual(workflow.jobs.pipeline.permissions, { contents: 'read', actions: 'write' })
  assert.equal(workflow.jobs.pipeline.concurrency.group, 'mbuild-release-dev-validation')
  assert.equal(workflow.jobs.pipeline.concurrency['cancel-in-progress'], false)
})

test('reports contain exact run links and expose prod approval only after a successful pipeline', () => {
  const results = {
    publish: { result: 'success' },
    assets: { result: 'success' },
    pipeline: {
      result: 'success',
      outputs: {
        dev_run_id: '101',
        dev_result: 'success',
        e2e_run_id: '202',
        e2e_result: 'success',
        prod_run_id: '303',
      },
    },
  }
  const report = releaseReport({ repo, tag, runId: '10', results })
  assert.match(report.payload.text, /prod review requested/)
  assert.equal(
    report.payload.blocks.find((block) => block.type === 'actions').elements[0].url,
    'https://github.com/boxlite-ai/boxlite/actions/runs/303',
  )
  assert.match(report.summary, /\[success\]\(https:\/\/github.com\/boxlite-ai\/boxlite\/actions\/runs\/202\)/)
  assert.ok(!report.summary.includes('<https:'))
  results.pipeline.result = 'failure'
  const failed = releaseReport({ repo, tag, runId: '10', results })
  assert.ok(!failed.payload.blocks.some((block) => block.type === 'actions'))
  assert.match(failed.payload.text, /failed/)
})

test('reports keep each prod request URL distinct across several validated releases', () => {
  for (const [release, runId] of [
    ['v0.13.1', '303'],
    ['v0.13.2', '404'],
    ['v0.13.3', '505'],
  ]) {
    const report = releaseReport({
      repo,
      tag: release,
      runId: '10',
      results: { pipeline: { result: 'success', outputs: { prod_run_id: runId } } },
    })
    assert.ok(
      report.payload.blocks.some((block) => block.type === 'actions' && block.elements[0].url.endsWith('/' + runId)),
    )
    assert.ok(report.payload.blocks.some((block) => block.text?.text?.includes('ref=' + release)))
  }
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
