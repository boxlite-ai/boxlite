// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

const SST_STAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

function validateSstStage(stage) {
  if (!SST_STAGE_PATTERN.test(stage)) {
    throw new Error(`invalid SST stage '${stage}' (expected letters, numbers, underscores, or hyphens)`)
  }
  return stage
}

export function resolveSstStage(args, environment = process.env) {
  let configuredStage

  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--stage') {
      const stage = args[index + 1]
      if (!stage || stage.startsWith('-')) throw new Error('--stage requires a value')
      if (configuredStage !== undefined) throw new Error('--stage may be specified only once')
      configuredStage = stage
      index += 1
      continue
    }

    const inlineStage = args[index].match(/^--stage=(.*)$/)?.[1]
    if (inlineStage !== undefined) {
      if (!inlineStage) throw new Error('--stage requires a value')
      if (configuredStage !== undefined) throw new Error('--stage may be specified only once')
      configuredStage = inlineStage
    }
  }

  if (configuredStage !== undefined) return validateSstStage(configuredStage)
  if (environment.SST_STAGE !== undefined && environment.SST_STAGE !== '') {
    return validateSstStage(environment.SST_STAGE)
  }
  if (args[0] === 'deploy' || args[0] === 'remove') {
    throw new Error(`${args[0]} requires an explicit --stage or SST_STAGE`)
  }
  return 'dev'
}

export function isSstComponentExcluded(args, component) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--exclude') {
      if (args[index + 1] === component) return true
      index += 1
      continue
    }

    if (args[index] === `--exclude=${component}`) return true
  }
  return false
}
