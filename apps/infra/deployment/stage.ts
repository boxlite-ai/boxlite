// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

// The fixed `boxlite-app-<stage>-artifacts-<account>` bucket is the strictest
// generated AWS name: its 35 non-stage characters leave 28 of S3's 63.
const SST_STAGE_PATTERN = /^[a-z0-9][a-z0-9-]{0,27}$/

function validateSstStage(stage: any) {
  if (!SST_STAGE_PATTERN.test(stage)) {
    throw new Error(`invalid SST stage '${stage}' (expected 1-28 lowercase letters, numbers, or hyphens)`)
  }
  return stage
}

export function resolveSstStage(args: any, environment = process.env) {
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

export function requireIamPermissionsBoundaryStage(stage: any, environment = process.env) {
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
