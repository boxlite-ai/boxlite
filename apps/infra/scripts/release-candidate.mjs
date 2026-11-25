// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const digestPattern = /^sha256:[a-f0-9]{64}$/
const assetName = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,200}$/
const metadata = 'release-candidate.json'
const raw = 'staged'
const bundle = process.env.RELEASE_ASSET_DIR || 'candidate'
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'))

export async function fileDigest(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return 'sha256:' + hash.digest('hex')
}
function numberId(value) {
  assert.ok(Number.isSafeInteger(Number(value)) && Number(value) > 0, 'Invalid GitHub ID or run attempt')
  return Number(value)
}
function gh(...args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
}
function api(path) {
  return JSON.parse(gh('api', 'repos/' + process.env.GITHUB_REPOSITORY + '/' + path))
}
async function tagIdentity(tag, sha) {
  assert.match(tag, /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/)
  assert.match(sha, /^[a-f0-9]{40}$/)
  assert.equal(api('commits/refs%2Ftags%2F' + tag).sha, sha, 'Release tag moved')
}
function artifactIndex(runId) {
  const pages = JSON.parse(
    gh(
      'api',
      '--paginate',
      '--slurp',
      'repos/' + process.env.GITHUB_REPOSITORY + '/actions/runs/' + numberId(runId) + '/artifacts?per_page=100',
    ),
  )
  return new Map(
    pages
      .flatMap((page) => page.artifacts)
      .filter((item) => !item.expired)
      .map((item) => [item.name, item.id]),
  )
}
async function archiveSources(tag, platforms) {
  const version = tag.slice(1)
  const names = new Map()
  const required = (group, files) => names.set(group, { required: files, accepts: (name) => files.includes(name) })
  const runtimes = ['install.sh', 'install.sh.sha256', 'SHA256SUMS']
  const packages = ['boxlite-ai-boxlite-' + version + '.tgz']
  for (const { target, rust_target, os } of platforms) {
    const runtime = 'boxlite-runtime-' + tag + '-' + target + '.tar.gz'
    const cli = 'boxlite-cli-' + tag + '-' + rust_target + '.tar.gz'
    runtimes.push(runtime, runtime + '.sha256', cli, cli + '.sha256')
    packages.push('boxlite-ai-boxlite-' + target + '-' + version + '.tgz')
    required('c-sdk-' + target, ['boxlite-c-' + tag + '-' + target + '.tar.gz'])
    names.set('wheels-' + os, {
      required: [],
      accepts: (name) => name.startsWith('boxlite-' + version + '-') && name.endsWith('.whl'),
    })
  }
  required('runtime-distribution', runtimes)
  required('node-packages', packages)
  const runner = 'boxlite-runner-' + tag + '-linux-amd64.tar.gz'
  required('runner-linux-amd64', [runner, runner + '.sha256'])
  return names
}
function verifyOrigin(source, sha, run, attempt) {
  assert.equal(source.sha, sha)
  assert.equal(source.run, run)
  assert.ok(numberId(source.attempt) <= attempt)
}

export function linuxClients(tag) {
  const version = tag.slice(1)
  return {
    'cli-linux-x64-gnu': ['boxlite-cli-' + tag + '-x86_64-unknown-linux-gnu.tar.gz'],
    'c-sdk-linux-x64-gnu': ['boxlite-c-' + tag + '-linux-x64-gnu.tar.gz'],
    'wheels-ubuntu-latest': ['boxlite-' + version + '-cp312-cp312-manylinux_2_28_x86_64.whl'],
    'npm-linux-x64-gnu': [
      'boxlite-ai-boxlite-' + version + '.tgz',
      'boxlite-ai-boxlite-linux-x64-gnu-' + version + '.tgz',
    ],
  }
}

// A run can be retried with a mix of reused and rebuilt jobs. Compare the actual
// accepted client bytes and deployment pins before certifying the complete distribution.
export function verifyAcceptedDistribution(candidate, acceptance, pins) {
  for (const key of ['tag', 'sha', 'run']) assert.equal(candidate[key], acceptance[key])
  for (const key of ['tag', 'sha', 'images', 'runner']) assert.deepEqual(candidate[key], pins[key])
  for (const name of Object.values(linuxClients(candidate.tag)).flat()) {
    assert.match(acceptance.clients[name], digestPattern)
    assert.equal(candidate.assets[name]?.digest, acceptance.clients[name], 'Release differs from dev E2E: ' + name)
  }
}

async function clientArtifactIds(tag) {
  const groups = Object.keys(linuxClients(tag))
  const run = numberId(process.env.GITHUB_RUN_ID)
  const attempt = numberId(process.env.GITHUB_RUN_ATTEMPT)
  const deadline = Date.now() + 120 * 60_000
  const producers = ['Build Runtime (linux-x64-gnu)', 'Build (linux-x64-gnu)', 'Build wheels on ubuntu-latest']
  while (Date.now() < deadline) {
    const jobs = JSON.parse(
      gh(
        'api',
        '--paginate',
        '--slurp',
        'repos/' +
          process.env.GITHUB_REPOSITORY +
          '/actions/runs/' +
          run +
          '/attempts/' +
          attempt +
          '/jobs?per_page=100',
      ),
    ).flatMap((page) => page.jobs)
    const index = artifactIndex(run)
    const missing = groups.filter((group) => !index.has(group))
    const linuxJobs = jobs.filter((job) => producers.some((name) => job.name.endsWith(' / ' + name)))
    const failed = linuxJobs.find((job) => ['failure', 'cancelled', 'timed_out'].includes(job.conclusion))
    assert.ok(!failed, 'Linux client build failed: ' + failed?.name)
    if (!missing.length && !linuxJobs.some((job) => job.status !== 'completed'))
      return groups.map((group) => numberId(index.get(group))).join(',')
    console.error('Waiting for Linux release clients: ' + (missing.join(', ') || 'producer completion'))
    await delay(30_000)
  }
  throw new Error('Timed out waiting for Linux client artifacts from this run')
}

async function prepareClients(candidate, directory) {
  const files = linuxClients(candidate.tag)
  const clients = {}
  for (const [group, names] of Object.entries(files)) {
    const source = join(directory, group)
    verifyOrigin(
      await readJson(join(source, 'producer.json')),
      candidate.sha,
      candidate.run,
      numberId(process.env.GITHUB_RUN_ATTEMPT),
    )
    for (const name of names) {
      await copyFile(join(source, name), join(bundle, name))
      clients[name] = await fileDigest(join(bundle, name))
    }
  }
  const [cli] = files['cli-linux-x64-gnu']
  await writeFile(join(bundle, cli + '.sha256'), clients[cli].slice(7) + '  ' + cli + '\n')
  await writeFile(join(bundle, 'tested-clients.json'), JSON.stringify(clients))
}

async function stage(mode, component) {
  const { TAG: tag, SHA: sha, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } = process.env
  await tagIdentity(tag, sha)
  const run = numberId(GITHUB_RUN_ID)
  const attempt = numberId(GITHUB_RUN_ATTEMPT)
  const index = artifactIndex(run)
  const deploymentOnly = mode === 'deployment'
  const groups = deploymentOnly ? [] : await archiveSources(tag, (await readJson('.github/ci-config.json')).platforms)
  const assets = {}
  const producers = {}
  async function origin(group) {
    const dir = join(raw, group)
    const source = await readJson(join(dir, 'producer.json'))
    verifyOrigin(source, sha, run, attempt)
    producers[group] = { id: numberId(index.get(group)), attempt: source.attempt }
    return dir
  }
  await mkdir(bundle)
  for (const [group, contract] of groups) {
    if (component && !group.startsWith(component)) continue
    const dir = await origin(group)
    const files = (await readdir(dir, { withFileTypes: true })).filter(({ name }) => name !== 'producer.json')
    assert.ok(files.length, 'Empty artifact ' + group)
    for (const name of contract.required)
      assert.ok(
        files.some((item) => item.name === name),
        'Missing ' + name,
      )
    for (const item of files) {
      const name = item.name
      assert.ok(
        item.isFile() && assetName.test(name) && contract.accepts(name) && !Object.hasOwn(assets, name),
        'Unexpected asset ' + name,
      )
      const path = join(dir, name)
      assert.ok((await stat(path)).size > 0, 'Empty file ' + name)
      assets[name] = { digest: await fileDigest(path), group }
      await copyFile(path, join(bundle, name))
    }
  }
  const candidate = { tag, sha, run, attempt, producers, assets }
  if (mode === 'component' && component !== 'runner-linux-amd64') {
    assert.ok(Object.keys(assets).length, 'No files for selected component')
  } else {
    const images = {}
    const expectedImages = JSON.parse(process.env.IMAGES)
    for (const image of expectedImages) {
      assert.match(image, /^[a-z][a-z0-9-]*$/)
      const dir = await origin('ghcr-' + image)
      const [entry] = await readJson(join(dir, 'image.json'))
      assert.equal(entry.artifact, image)
      assert.match(entry.digest, digestPattern)
      images[image] = entry.digest
    }
    const runner = await readJson(join(await origin('ghcr-runner'), 'runner.json'))
    assert.match(runner.manifest, digestPattern)
    assert.match(runner.archive, digestPattern)
    if (!deploymentOnly) assert.equal(runner.archive, assets['boxlite-runner-' + tag + '-linux-amd64.tar.gz'].digest)
    Object.assign(candidate, { images, runner })
  }
  await writeFile(join(bundle, metadata), JSON.stringify(candidate, null, 2) + '\n')
  return candidate
}
export async function verifyCandidate(directory, { tag, sha, fingerprint }) {
  const path = join(directory, metadata)
  assert.match(fingerprint, digestPattern)
  assert.equal(await fileDigest(path), fingerprint, 'Unrecognized release candidate')
  const candidate = await readJson(path)
  assert.equal(candidate.tag, tag)
  assert.equal(candidate.sha, sha)
  for (const [name, { digest }] of Object.entries(candidate.assets)) {
    assert.ok(assetName.test(name))
    assert.equal(await fileDigest(join(directory, name)), digest, 'Changed release asset ' + name)
  }
  return candidate
}
function releaseAssets(releaseId) {
  return JSON.parse(
    gh(
      'api',
      '--paginate',
      '--slurp',
      'repos/' + process.env.GITHUB_REPOSITORY + '/releases/' + numberId(releaseId) + '/assets?per_page=100',
    ),
  ).flat()
}
async function publishFiles(candidate, id, scope, finalize = false) {
  const release = api('releases/' + numberId(id))
  assert.equal(release.tag_name, candidate.tag)
  if (!scope && !finalize) assert.equal(release.draft, true, 'Release must be a draft during normal asset publication')
  const files = Object.fromEntries(
    Object.entries(candidate.assets).filter(([, { group }]) => !scope || group.startsWith(scope)),
  )
  assert.ok(Object.keys(files).length, 'No files for requested component')
  if (!scope) files[metadata] = { digest: await fileDigest(join(bundle, metadata)) }
  const uploadedAssets = () => new Map(releaseAssets(id).map((entry) => [entry.name, entry]))
  if (!finalize) {
    const existing = uploadedAssets()
    for (const [name, { digest }] of Object.entries(files)) {
      if (existing.has(name))
        assert.equal(existing.get(name).digest, digest, 'Release already holds different bytes for ' + name)
      else gh('release', 'upload', candidate.tag, join(bundle, name), '--repo', process.env.GITHUB_REPOSITORY)
    }
  }
  const uploaded = uploadedAssets()
  for (const [name, { digest }] of Object.entries(files)) {
    assert.equal(uploaded.get(name)?.state, 'uploaded', 'Incomplete upload ' + name)
    assert.equal(uploaded.get(name)?.digest, digest, 'Uploaded asset differs from candidate: ' + name)
  }
  if (finalize && release.draft)
    gh(
      'api',
      '--method',
      'PATCH',
      'repos/' + process.env.GITHUB_REPOSITORY + '/releases/' + numberId(id),
      '-F',
      'draft=false',
      '-F',
      'prerelease=false',
    )
}
async function main(command) {
  const { TAG: tag, SHA: sha, CANDIDATE_DIGEST: fingerprint, RELEASE_ID } = process.env
  if (command === 'client-ids') {
    await tagIdentity(tag, sha)
    console.log(await clientArtifactIds(tag))
    return
  }
  if (['stage', 'deployment', 'component'].includes(command)) {
    const group = command === 'component' ? process.env.COMPONENT_GROUP : ''
    if (command === 'component')
      assert.ok(['runtime-distribution', 'wheels-', 'node-packages', 'c-sdk-', 'runner-linux-amd64'].includes(group), 'Unknown component group')
    await stage(command, group)
    console.log(await fileDigest(join(bundle, metadata)))
    return
  }
  const candidate = await verifyCandidate(bundle, { tag, sha, fingerprint })
  if (command === 'verify') return
  if (command === 'clients') return prepareClients(candidate, process.env.CLIENT_ARTIFACT_DIR)
  if (command === 'check-acceptance') {
    const acceptance = await readJson(process.env.ACCEPTANCE_FILE)
    assert.equal(acceptance.digest, process.env.DEPLOYMENT_DIGEST)
    assert.equal(acceptance.candidate, numberId(process.env.DEPLOYMENT_ID))
    assert.equal(acceptance.attempt, numberId(process.env.ACCEPTED_ATTEMPT))
    return verifyAcceptedDistribution(candidate, acceptance, JSON.parse(process.env.DEPLOYMENT_PINS))
  }
  await tagIdentity(tag, sha)
  if (command === 'attach') return publishFiles(candidate, RELEASE_ID, process.env.REPAIR_GROUP)
  if (command === 'finalize') return publishFiles(candidate, RELEASE_ID, undefined, true)
  throw new Error('Unknown release candidate operation ' + command)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv[2])
