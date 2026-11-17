// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const VERSION = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
const HOUR = 60 * 60 * 1000
const clock = { now: Date.now, wait: sleep }
const output = (name, value) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, name + '=' + value + '\n')
}
const id = (value) => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('GitHub returned an invalid run or release ID')
  return value
}
const timestamp = (value) => {
  const time = typeof value === 'string' ? Date.parse(value) : NaN
  if (!Number.isFinite(time)) throw new Error('GitHub returned unavailable workflow attempt timing')
  return time
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

export class ReleasePipeline {
  #repo
  #requiredAssets
  #tag
  #sha
  #token
  #request
  #timer
  #record
  #log

  constructor({ repo, tag, sha, token, request = fetch, timer = clock, record = output, log = console.log }) {
    this.#repo = repository(repo)
    this.#requiredAssets = releaseAssets(tag)
    if (!token) throw new Error('GH_TOKEN is required')
    this.#tag = tag
    this.#sha = sha
    this.#token = token
    this.#request = request
    this.#timer = timer
    this.#record = record
    this.#log = log
  }

  async #api(path, body) {
    const method = body === undefined ? 'GET' : 'POST'
    let response
    try {
      response = await this.#request('https://api.github.com/repos/' + this.#repo + path, {
        method,
        headers: {
          Authorization: 'Bearer ' + this.#token,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2026-03-10',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      })
    } catch {
      throw new Error(
        method === 'POST' ? 'Dispatch outcome unknown; inspect GitHub before retrying' : 'GitHub read failed',
      )
    }
    if (!response.ok) {
      throw new Error(
        'GitHub ' +
          method +
          ' failed: HTTP ' +
          response.status +
          (method === 'POST' && response.status >= 500 ? '; dispatch outcome unknown, inspect before retrying' : ''),
      )
    }
    try {
      const result = await response.json()
      if (result === null || typeof result !== 'object') throw new Error('Invalid JSON document')
      return result
    } catch {
      throw new Error(
        method === 'POST'
          ? 'Dispatch outcome unknown: no readable run ID; inspect before retrying'
          : 'Malformed GitHub JSON response',
      )
    }
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

  async #assertTag() {
    if (!/^[0-9a-f]{40}$/.test(this.#sha ?? ''))
      throw new Error('The publisher must supply its resolved release commit')
    const commit = await this.#api('/commits/' + encodeURIComponent('refs/tags/' + this.#tag))
    if (commit.sha !== this.#sha) throw new Error('Release tag moved after publication; refusing downstream dispatch')
  }

  async #dispatch(workflow, inputs, name) {
    await this.#assertTag()
    const result = await this.#api('/actions/workflows/' + workflow + '/dispatches', { ref: 'main', inputs })
    let runId
    try {
      runId = id(result?.workflow_run_id)
    } catch {
      throw new Error('Dispatch outcome unknown: no valid run ID; inspect GitHub before retrying')
    }
    this.#record(name + '_run_id', runId)
    this.#log(name + ': https://github.com/' + this.#repo + '/actions/runs/' + runId)
    return runId
  }

  async #completed(runId, name, timeout) {
    return this.#poll(
      async () => {
        const run = await this.#api('/actions/runs/' + runId)
        if (run.id !== runId || typeof run.status !== 'string')
          throw new Error('GitHub returned an unexpected workflow run')
        if (run.status !== 'completed') return undefined
        const conclusion = /^[a-z_]+$/.test(run.conclusion ?? '') ? run.conclusion : 'unknown'
        this.#record(name + '_result', conclusion)
        if (conclusion !== 'success') throw new Error(name + ' run ' + runId + ' ended with ' + conclusion)
        return run
      },
      timeout,
      () => name + ' run ' + runId,
    )
  }

  async #undisturbed(dev, e2e) {
    const start = timestamp(dev.updated_at)
    const end = timestamp(e2e.updated_at)
    if (end < start) throw new Error('GitHub returned an invalid validation interval')
    if (!Number.isSafeInteger(dev.run_attempt) || dev.run_attempt < 1 || dev.run_attempt > 50) {
      throw new Error('Deployment attempt history cannot be verified')
    }
    const check = (run) => {
      const started = timestamp(run.run_started_at)
      const updated = timestamp(run.updated_at)
      if (started > end || (run.status === 'completed' && updated < start)) return
      throw new Error('Dev validation overlapped another or unidentified apply: run ' + run.id)
    }
    // Inspect attempts, including failed/cancelled applies and reruns of old run IDs.
    for (let page = 1; page <= 5; page++) {
      const result = await this.#api(
        '/actions/workflows/mdeploy-all.yml/runs?event=workflow_dispatch&per_page=100&page=' + page,
      )
      if (!Array.isArray(result.workflow_runs)) throw new Error('Malformed deployment history')
      for (const run of result.workflow_runs) {
        const ownRun = id(run.id) === dev.id
        if (ownRun && run.run_attempt === dev.run_attempt) continue
        if (/^preview (dev|stage|prod) ·/.test(run.display_title) || /^deploy (stage|prod) ·/.test(run.display_title))
          continue
        if (timestamp(run.created_at) > end || (run.status === 'completed' && timestamp(run.updated_at) < start))
          continue
        if (!Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 || run.run_attempt > 50) {
          throw new Error('Deployment attempt history cannot be verified')
        }
        if (run.run_attempt === 1) check(run)
        else
          for (let attempt = 1; attempt <= run.run_attempt; attempt++) {
            if (ownRun && attempt === dev.run_attempt) continue
            check(await this.#api('/actions/runs/' + run.id + '/attempts/' + attempt))
          }
      }
      if (result.workflow_runs.length < 100) return
    }
    throw new Error('Deployment history was truncated; refusing a prod request')
  }

  async run() {
    const inputs = { stage: 'dev', components: 'api+runner', ref: this.#tag, apply: true, confirm: true }
    const devId = await this.#dispatch('mdeploy-all.yml', inputs, 'dev')
    const dev = await this.#completed(devId, 'dev', 3 * HOUR)
    const e2eId = await this.#dispatch('e2e-cloud.yml', { stage: 'dev', tag: this.#tag }, 'e2e')
    const e2e = await this.#completed(e2eId, 'e2e', HOUR)
    await this.#undisturbed(dev, e2e)
    const environment = await this.#api('/environments/prod')
    if (
      !Array.isArray(environment.protection_rules) ||
      !environment.protection_rules.some(
        (rule) => rule.type === 'required_reviewers' && Array.isArray(rule.reviewers) && rule.reviewers.length > 0,
      )
    ) {
      throw new Error('Prod must have required Environment reviewers before a prod run can be created')
    }
    // Creation fixes inputs; GitHub Environment approval remains a separate human action.
    await this.#dispatch('mdeploy-all.yml', { ...inputs, stage: 'prod' }, 'prod')
  }
}

export const releaseReport = ({ repo, tag, runId, results }) => {
  repository(repo)
  const source = 'https://github.com/' + repo
  const pipeline = results.pipeline ?? {}
  const outputs = pipeline.outputs ?? {}
  const link = (value, label) =>
    /^[1-9][0-9]*$/.test(String(value ?? '')) ? '<' + source + '/actions/runs/' + value + '|' + label + '>' : label
  const success = pipeline.result === 'success' && /^[1-9][0-9]*$/.test(outputs.prod_run_id ?? '')
  const release = VERSION.test(tag) ? tag : '(invalid release tag)'
  const title = release + (success ? ': dev verified; prod review requested' : ': release pipeline failed')
  const rows = [
    ['Publication', results.publish?.result ?? 'not started'],
    ['Release assets', results.assets?.result ?? 'not started'],
    ['Dev deployment', link(outputs.dev_run_id, outputs.dev_result ?? 'not completed')],
    ['E2E cloud', link(outputs.e2e_run_id, outputs.e2e_result ?? 'not completed')],
    ['Validation / prod request', pipeline.result ?? 'not started'],
  ]
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: title } },
    { type: 'section', fields: rows.map(([name, value]) => ({ type: 'mrkdwn', text: '*' + name + '*\n' + value })) },
    { type: 'section', text: { type: 'mrkdwn', text: link(runId, 'Release pipeline logs') } },
  ]
  if (success) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          'Prod inputs: stage=prod, ref=' +
          release +
          ', components=api+runner, apply=true, confirm=true. Review and approve in GitHub.',
      },
    })
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          style: 'primary',
          text: { type: 'plain_text', text: 'Review prod deployment' },
          url: source + '/actions/runs/' + outputs.prod_run_id,
        },
      ],
    })
  }
  const summary =
    '## ' +
    title +
    '\n\n| Stage | Result |\n| --- | --- |\n' +
    rows
      .map(([name, value]) => '| ' + name + ' | ' + value.replace(/<([^>|]+)\|([^>]+)>/g, '[$2]($1)') + ' |')
      .join('\n') +
    '\n' +
    (success ? '\nProd run: ' + source + '/actions/runs/' + outputs.prod_run_id + '\n' : '')
  return { payload: { text: title, blocks }, summary }
}

export const sendSlack = async (webhook, payload, request = fetch) => {
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
      await sendSlack(process.env.SLACK_WEBHOOK_URL, report.payload)
    } else {
      const pipeline = new ReleasePipeline({
        repo: process.env.GITHUB_REPOSITORY,
        tag: process.env.TAG,
        sha: process.env.RELEASE_SHA,
        token: process.env.GH_TOKEN,
      })
      if (process.argv[2] === 'assets') {
        slackWebhook(process.env.SLACK_WEBHOOK_URL)
        await pipeline.waitForAssets()
      } else if (process.argv[2] === 'run') await pipeline.run()
      else throw new Error('Expected assets, run, or report')
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Release pipeline failed')
    process.exitCode = 1
  }
}
