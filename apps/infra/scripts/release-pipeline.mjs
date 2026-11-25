// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const VERSION = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
const HOUR = 60 * 60 * 1000
const clock = { now: Date.now, wait: sleep }
const id = (value) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('GitHub returned an invalid run or release ID')
  return value
}
const repository = (value) => {
  if (
    !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(value) ||
    value.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error('GITHUB_REPOSITORY must be an owner/repository slug')
  }
  return value
}

export const releaseAssets = (tag) => {
  if (!VERSION.test(tag)) throw new Error('TAG must be a stable vX.Y.Z release tag')
  const version = tag.slice(1)
  const runner = 'boxlite-runner-' + tag + '-linux-amd64.tar.gz'
  return [
    runner,
    runner + '.sha256',
    'boxlite-' + version + '-cp312-cp312-manylinux_2_28_x86_64.whl',
    'boxlite-ai-boxlite-' + version + '.tgz',
    'boxlite-ai-boxlite-linux-x64-gnu-' + version + '.tgz',
    'boxlite-c-' + tag + '-linux-x64-gnu.tar.gz',
    'boxlite-cli-' + tag + '-x86_64-unknown-linux-gnu.tar.gz',
    'install.sh',
  ]
}

export const slackWebhook = (value) => {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new Error('SLACK_WEBHOOK_URL must be configured as an incoming Slack webhook')
  }
  if (
    url.protocol !== 'https:' ||
    !['hooks.slack.com', 'hooks.slack-gov.com'].includes(url.hostname) ||
    !/^\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(url.pathname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('SLACK_WEBHOOK_URL must be a credential-free HTTPS Slack incoming webhook URL')
  }
  return url.href
}

async function githubRequest(repo, token, request, path) {
  const response = await request('https://api.github.com/repos/' + repo + path, {
    method: 'GET',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2026-03-10',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  }).catch(() => {
    throw new Error('GitHub read failed: ' + path)
  })
  if (!response.ok) throw new Error('GitHub GET ' + path + ' failed: HTTP ' + response.status)
  const result = await response.json().catch(() => null)
  if (result === null || typeof result !== 'object') throw new Error('Malformed GitHub JSON response')
  return result
}

export class ReleasePipeline {
  #repo
  #requiredAssets
  #tag
  #api
  #timer
  #log

  constructor({ repo, tag, token, request = fetch, timer = clock, log = console.log }) {
    this.#repo = repository(repo)
    this.#requiredAssets = releaseAssets(tag)
    if (!token) throw new Error('GH_TOKEN is required')
    this.#tag = tag
    this.#api = (path) => githubRequest(this.#repo, token, request, path)
    this.#timer = timer
    this.#log = log
  }

  async #poll(read, timeout, describe) {
    const deadline = this.#timer.now() + timeout
    while (this.#timer.now() < deadline) {
      const result = await read()
      if (result !== undefined) return result
      if (this.#timer.now() >= deadline) break
      await this.#timer.wait(Math.min(30_000, deadline - this.#timer.now()))
    }
    throw new Error('Timed out waiting for ' + describe())
  }

  async waitForAssets() {
    const release = await this.#api('/releases/tags/' + this.#tag)
    if (release.tag_name !== this.#tag || release.draft !== false)
      throw new Error('The selected GitHub Release must be published')
    const releaseId = id(release.id)
    let missing = this.#requiredAssets
    await this.#poll(
      async () => {
        const uploaded = new Set()
        for (let page = 1; page <= 10; page++) {
          const assets = await this.#api('/releases/' + releaseId + '/assets?per_page=100&page=' + page)
          if (!Array.isArray(assets)) throw new Error('Malformed GitHub release asset list')
          for (const asset of assets) {
            if (typeof asset?.name !== 'string' || typeof asset.state !== 'string' || !Number.isFinite(asset.size)) {
              throw new Error('Malformed GitHub release asset')
            }
            if (asset.state === 'uploaded' && asset.size > 0) uploaded.add(asset.name)
          }
          if (assets.length < 100) break
          if (page === 10) throw new Error('Release asset pagination exceeded its verification limit')
        }
        missing = this.#requiredAssets.filter((name) => !uploaded.has(name))
        if (missing.length === 0) return true
        this.#log('Waiting for release assets: ' + missing.join(', '))
      },
      3 * HOUR,
      () => 'release assets: ' + missing.join(', '),
    )
  }
}

const runButton = (repo, runId, label) => ({
  type: 'actions',
  elements: [
    {
      type: 'button',
      style: 'primary',
      text: { type: 'plain_text', text: label },
      url: 'https://github.com/' + repository(repo) + '/actions/runs/' + id(Number(runId)),
    },
  ],
})

export const releaseReport = ({ repo, tag, runId, results }) => {
  const release = VERSION.test(tag) ? tag : '(invalid release tag)'
  const rows = [
    ['Release ref', results.resolve?.result],
    ...Object.entries(results).filter(([job]) => job.startsWith('build-')).map(([job, outcome]) => [job, outcome.result]),
    ['Image publication', results.publish?.result],
    ...(results['publish-runner'] ? [['Runner publication', results['publish-runner'].result]] : []),
    ['Release assets', results.distribution?.result],
  ].map(([label, result]) => [label, result ?? 'not started'])
  if (results.dev && results.dev.result !== 'skipped') {
    const e2e = results.dev.outputs?.e2e_result
    if (!e2e || e2e === 'skipped') rows.push(['Dev deployment and acceptance', results.dev.result])
    if (e2e) rows.push(['E2E cloud', e2e])
  }
  for (const [job, label] of Object.entries({
    attach: 'Draft attachments', pypi: 'PyPI', npm: 'npm', 'tag-go-module': 'Go module tag',
    finalize: 'GitHub Release', publish_crates: 'crates.io',
  })) {
    if (results[job]) rows.push([label, results[job].result])
  }
  const stopped = rows.find(([, result]) => ['failure', 'cancelled'].includes(result)) ??
    rows.find(([, result]) => result !== 'success')
  const phase = stopped?.[0] ?? 'Release'
  const title = release + ': ' + phase + ' — ' + (stopped?.[1] ?? 'stopped')
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: title } },
    ...Array.from({ length: Math.ceil(rows.length / 10) }, (_, i) => ({
      type: 'section',
      fields: rows.slice(i * 10, i * 10 + 10).map(([key, value]) => ({ type: 'plain_text', text: key + '\n' + value })),
    })),
    runButton(repo, runId, 'View run logs'),
  ]
  const summary =
    '## ' +
    title +
    '\n\n| Stage | Result |\n| --- | --- |\n' +
    rows.map(([key, value]) => '| ' + key + ' | ' + value + ' |').join('\n') +
    '\n'
  return { payload: { text: title, blocks }, summary, environment: 'dev', phase }
}

export const sendSlack = async (webhook, payload, request = fetch) => {
  payload = { ...payload, text: '[SHADOW] ' + payload.text, blocks: payload.blocks.map(block => block.type === 'header' ? { ...block, text: { ...block.text, text: '[SHADOW] ' + block.text.text } } : block) }
  const url = slackWebhook(webhook)
  let response
  try {
    response = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw new Error('Slack notification failed; webhook URL omitted')
  }
  if (!response.ok) throw new Error('Slack notification failed: HTTP ' + response.status)
}

async function sendRunSlack({ payload, environment, phase }) {
  const {
    SLACK_WEBHOOK_URL: webhook,
    GITHUB_REPOSITORY,
    GITHUB_RUN_ID,
    GITHUB_WORKFLOW,
    GITHUB_ACTOR,
    GH_TOKEN,
  } = process.env
  if (!webhook) return
  slackWebhook(webhook)
  const runId = id(Number(GITHUB_RUN_ID))
  const run = await githubRequest(repository(GITHUB_REPOSITORY), GH_TOKEN, fetch, '/actions/runs/' + runId)
  if (run.id !== runId || !run.display_title || typeof run.display_title !== 'string') {
    throw new Error('GitHub returned no title for the sending workflow run')
  }
  const fields = [
    ['Workflow', GITHUB_WORKFLOW],
    ['Run', run.display_title],
    ['GitHub actor', GITHUB_ACTOR],
    ['Environment', environment],
    ['Phase', phase],
  ].map(([label, value]) => ({ type: 'plain_text', text: label + '\n' + value }))
  const [header, ...details] = payload.blocks
  await sendSlack(webhook, { ...payload, blocks: [header, { type: 'section', fields }, ...details] })
}

function notifyApproval(runId, environment, phase, title) {
  return sendRunSlack({
    environment,
    phase,
    payload: {
      text: title,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: title } },
        runButton(process.env.GITHUB_REPOSITORY, runId, 'Review ' + environment + ' deployment'),
      ],
    },
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    if (process.argv[2] === 'report') {
      const report = releaseReport({
        repo: process.env.GITHUB_REPOSITORY,
        tag: process.env.TAG,
        runId: process.env.GITHUB_RUN_ID,
        results: JSON.parse(process.env.RELEASE_RESULTS),
      })
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report.summary)
      await sendRunSlack(report)
    } else if (process.argv[2] === 'result') {
      const {
        DEPLOY_ENVIRONMENT: environment,
        DEPLOY_RESULT: result,
        DEPLOY_REF: ref,
        GITHUB_REPOSITORY: repo,
        GITHUB_RUN_ID: runId,
      } = process.env
      const title = environment + ' deployment: ' + result
      await sendRunSlack({
        environment,
        phase: 'Deployment result',
        payload: {
          text: title,
          blocks: [
            { type: 'header', text: { type: 'plain_text', text: title } },
            { type: 'section', text: { type: 'plain_text', text: 'Ref: ' + ref } },
            runButton(repo, runId, result === 'failure' ? 'View run logs' : 'View deployment run'),
          ],
        },
      })
    } else if (process.argv[2] === 'approval') {
      const { DEPLOY_ENVIRONMENT, APPROVAL_PHASE, GITHUB_RUN_ID, ACCEPTED_TAG } = process.env
      const title = ACCEPTED_TAG
        ? ACCEPTED_TAG + ': dev E2E passed · review prod deployment'
        : 'Deployment review requested'
      try {
        await notifyApproval(GITHUB_RUN_ID, DEPLOY_ENVIRONMENT, APPROVAL_PHASE, title)
      } catch {
        console.warn('::warning::Deployment approval notice failed. Review this run in GitHub.')
      }
    } else if (process.argv[2] === 'assets') {
      if (process.env.SLACK_WEBHOOK_URL) slackWebhook(process.env.SLACK_WEBHOOK_URL)
      await new ReleasePipeline({
        repo: process.env.GITHUB_REPOSITORY,
        tag: process.env.TAG,
        token: process.env.GH_TOKEN,
      }).waitForAssets()
    } else throw new Error('Expected assets, approval, result or report')
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Release pipeline failed')
    process.exitCode = 1
  }
}
