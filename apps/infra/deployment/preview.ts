// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

// eslint-disable-next-line @nx/enforce-module-boundaries -- Deployment validation shares the policy host's CommonJS Runner model.
import runnerInventory from '../runner/model/inventory.js'

const { isRunnerLikeResource } = runnerInventory

const MAX_PREVIEW_BYTES = 32 * 1024 * 1024

function resourceName(urn: any) {
  return urn.slice(urn.lastIndexOf('::') + 2)
}

function isAllowedRunnerUpdatePath(path: any) {
  return (
    path === '__provider' ||
    path === 'tags' ||
    path.startsWith('tags.') ||
    path.startsWith('tags[') ||
    path === 'tagsAll' ||
    path.startsWith('tagsAll.') ||
    path.startsWith('tagsAll[')
  )
}

export function validateDeploymentPreview(rawPreview: any) {
  let changes
  try {
    changes = JSON.parse(rawPreview)
  } catch (error: any) {
    throw new Error(`SST deployment preview is not valid JSON: ${error.message}`)
  }
  if (!Array.isArray(changes)) throw new Error('SST deployment preview must be a JSON array')

  const runnerUpdates = []
  const unsafeRunnerChanges = []

  for (const [index, change] of changes.entries()) {
    if (
      !change ||
      typeof change !== 'object' ||
      typeof change.op !== 'string' ||
      typeof change.urn !== 'string' ||
      typeof change.type !== 'string'
    ) {
      throw new Error(`SST deployment preview entry ${index} is not a valid resource change`)
    }

    const name = resourceName(change.urn)
    const isRunner =
      isRunnerLikeResource({ name, type: change.type, properties: change.old?.inputs }) ||
      isRunnerLikeResource({ name, type: change.type, properties: change.new?.inputs })
    if (!isRunner) continue

    const paths = Object.keys(change.detailedDiff ?? {})
    const isSafeUpdate =
      change.op === 'update' &&
      change.new?.protect === true &&
      paths.length > 0 &&
      paths.every(isAllowedRunnerUpdatePath)

    if (!isSafeUpdate) {
      unsafeRunnerChanges.push(`${name}: ${change.op} (${paths.join(', ') || 'no detailed diff'})`)
      continue
    }
    runnerUpdates.push({ name, paths })
  }

  if (unsafeRunnerChanges.length > 0) {
    throw new Error(`unsafe Runner deployment plan: ${unsafeRunnerChanges.join('; ')}`)
  }

  return { changeCount: changes.length, runnerUpdates }
}

async function readPreviewFromStdin() {
  process.stdin.setEncoding('utf8')
  let rawPreview = ''
  let previewBytes = 0

  for await (const chunk of process.stdin) {
    previewBytes += Buffer.byteLength(chunk)
    if (previewBytes > MAX_PREVIEW_BYTES) {
      throw new Error(`SST deployment preview exceeds ${MAX_PREVIEW_BYTES} bytes`)
    }
    rawPreview += chunk
  }
  return rawPreview
}

async function main() {
  const preview = validateDeploymentPreview(await readPreviewFromStdin())
  console.log(`deployment-preview: ${preview.changeCount} planned resource change(s) passed the Runner safety gate`)
  for (const update of preview.runnerUpdates) {
    console.log(`deployment-preview: ${update.name} has a safe in-place update (${update.paths.join(', ')})`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main()
  } catch (error: any) {
    console.error(`deployment-preview: ${error.message}`)
    process.exitCode = 1
  }
}
