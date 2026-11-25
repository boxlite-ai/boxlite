// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
async function stage() {
  const { TAG: tag, SHA: sha, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT } = process.env
  await tagIdentity(tag, sha)
  const run = numberId(GITHUB_RUN_ID)
  const attempt = numberId(GITHUB_RUN_ATTEMPT)
  const index = artifactIndex(run)
  const groups = await archiveSources(tag, (await readJson('.github/ci-config.json')).platforms)
  const assets = {}
  const producers = {}
  async function origin(group) {
    const dir = join(raw, group)
    const source = await readJson(join(dir, 'producer.json'))
    assert.equal(source.run, run)
    assert.equal(source.sha, sha)
    assert.ok(numberId(source.attempt) <= attempt)
    producers[group] = { id: numberId(index.get(group)), attempt: source.attempt }
    return dir
  }
  await mkdir(bundle)
  for (const [group, contract] of groups) {
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
  assert.equal(runner.archive, assets['boxlite-runner-' + tag + '-linux-amd64.tar.gz'].digest)
  const candidate = { tag, sha, run, attempt, producers, assets, images, runner }
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
    gh('api', '--method', 'PATCH', 'repos/' + process.env.GITHUB_REPOSITORY + '/releases/' + numberId(id), '-F', 'draft=false')
}
async function main(command) {
  const { TAG: tag, SHA: sha, CANDIDATE_DIGEST: fingerprint, RELEASE_ID } = process.env
  if (command === 'stage') {
    await stage()
    console.log(await fileDigest(join(bundle, metadata)))
    return
  }
  const candidate = await verifyCandidate(bundle, { tag, sha, fingerprint })
  if (command === 'verify') return
  await tagIdentity(tag, sha)
  if (command === 'attach') return publishFiles(candidate, RELEASE_ID, process.env.REPAIR_GROUP)
  if (command === 'finalize') return publishFiles(candidate, RELEASE_ID, undefined, true)
  throw new Error('Unknown release candidate operation ' + command)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv[2])
