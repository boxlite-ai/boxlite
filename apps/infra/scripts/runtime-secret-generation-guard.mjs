// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { execFileSync } from 'node:child_process'

import {
  PENDING_RUNTIME_SECRET_GENERATION,
  validateRuntimeSecretGenerations,
} from './deployment-config.mjs'
import {
  RUNTIME_SECRET_DEFINITIONS,
  RUNTIME_SECRET_INITIALIZATION_TAG,
  RUNTIME_SECRET_INITIAL_VALUE_TAG,
  runtimeSecretName,
  runtimeSecretNeedsGeneratedInitialVersion,
} from './runtime-secrets.mjs'
import {
  currentRuntimeSecretVersionId,
  normalizeRuntimeSecretVersionStages,
} from './runtime-secret-version-stages.mjs'

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseCurrentGeneration(source) {
  let metadata
  try {
    metadata = JSON.parse(source)
  } catch {
    throw new Error('could not verify runtime secret generations from AWS metadata')
  }
  if (!isPlainObject(metadata)) {
    throw new Error('could not verify runtime secret generations from AWS metadata')
  }
  const versionStages = normalizeRuntimeSecretVersionStages(metadata)
  if (!Array.isArray(metadata.Tags)) {
    throw new Error('could not verify runtime secret generations from AWS metadata')
  }
  const requiredTagValues = {}
  for (const key of [RUNTIME_SECRET_INITIAL_VALUE_TAG, RUNTIME_SECRET_INITIALIZATION_TAG]) {
    const matches = metadata.Tags.filter((tag) => isPlainObject(tag) && tag.Key === key)
    if (matches.length !== 1 || typeof matches[0].Value !== 'string') {
      throw new Error('could not verify runtime secret generations from AWS metadata')
    }
    requiredTagValues[key] = matches[0].Value
  }
  const needsGeneratedInitialVersion = runtimeSecretNeedsGeneratedInitialVersion(requiredTagValues)

  const currentVersionId = currentRuntimeSecretVersionId(versionStages)
  if (currentVersionId === undefined) {
    if (!needsGeneratedInitialVersion || Object.keys(versionStages).length !== 0) {
      throw new Error('could not verify runtime secret generations from AWS metadata')
    }
    return PENDING_RUNTIME_SECRET_GENERATION
  }
  if (needsGeneratedInitialVersion) {
    throw new Error('could not verify runtime secret generations from AWS metadata')
  }
  return currentVersionId
}

export function readRuntimeSecretGenerations({
  stage,
  region,
  awsCliPath,
  executeAws,
} = {}) {
  if (typeof awsCliPath !== 'string' || !awsCliPath) {
    throw new Error('runtime secret generation guard requires awsCliPath')
  }
  if (typeof region !== 'string' || !region) {
    throw new Error('runtime secret generation guard requires region')
  }

  const execute =
    executeAws ??
    (({ args }) =>
      execFileSync(awsCliPath, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
        killSignal: 'SIGTERM',
        maxBuffer: 1024 * 1024,
      }))

  const actual = {}
  try {
    for (const definition of RUNTIME_SECRET_DEFINITIONS) {
      const source = execute({
        args: [
          'secretsmanager',
          'describe-secret',
          '--secret-id',
          runtimeSecretName(stage, definition.id),
          '--query',
          '{VersionIdsToStages:VersionIdsToStages,Tags:Tags}',
          '--output',
          'json',
          '--region',
          region,
          '--no-cli-pager',
        ],
      })
      actual[definition.id] = parseCurrentGeneration(source)
    }
    return Object.freeze(validateRuntimeSecretGenerations(actual))
  } catch {
    throw new Error('could not verify runtime secret generations from AWS metadata')
  }
}

export function assertRuntimeSecretGenerationsCurrent(options = {}) {
  let expected
  try {
    expected = validateRuntimeSecretGenerations(options.expectedGenerations)
  } catch {
    throw new Error('the pinned deployment config has an invalid runtime secret generation map')
  }
  const actual = readRuntimeSecretGenerations(options)

  if (RUNTIME_SECRET_DEFINITIONS.some(({ id }) => actual[id] !== expected[id])) {
    throw new Error(
      'runtime secret generations do not match the pinned deployment config; rerun bootstrap to publish the current generations',
    )
  }
  return Object.freeze(expected)
}
