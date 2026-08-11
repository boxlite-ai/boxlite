// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

const SST_STAGE_PATTERN = /^[a-z0-9]{1,20}$/

function validateSstStage(stage) {
  if (!SST_STAGE_PATTERN.test(stage)) {
    throw new Error(`invalid SST stage '${stage}' (expected 1-20 lowercase letters or numbers)`)
  }
  return stage
}

export function resolveSstStage(args, environment = process.env) {
  let configuredStage

  for (let index = 0; index < args.length; index++) {
    const argument = args[index]
    if (argument === '--') break

    if (argument === '--stage') {
      const stage = args[index + 1]
      if (!stage || stage.startsWith('-')) throw new Error('--stage requires a value')
      if (configuredStage !== undefined) throw new Error('--stage may be specified only once')
      configuredStage = stage
      index += 1
      continue
    }

    const inlineStage = argument.match(/^--stage=(.*)$/)?.[1]
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
  if (['diff', 'deploy', 'remove', 'refresh', 'shell'].includes(args[0])) {
    throw new Error(`${args[0]} requires an explicit --stage or SST_STAGE`)
  }
  return 'dev'
}

export function requireIamPermissionsBoundaryStage(stage, environment = process.env) {
  const selectedStage = validateSstStage(stage)
  const configuredStage = environment.IAM_PERMISSIONS_BOUNDARY_STAGE
  if (!configuredStage) {
    throw new Error('IAM_PERMISSIONS_BOUNDARY_STAGE is required to identify the provisioned runtime boundary')
  }

  const boundaryStage = validateSstStage(configuredStage)
  if (boundaryStage !== selectedStage) {
    throw new Error(`IAM permissions boundary stage ${boundaryStage} does not match SST stage ${selectedStage}`)
  }
  return boundaryStage
}
