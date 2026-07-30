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
  let selector
  const selectedComponents = new Set()

  for (let index = 0; index < args.length; index += 1) {
    const separateSelector = args[index].match(/^--(target|exclude)$/)?.[1]
    if (separateSelector) {
      const value = args[index + 1]
      if (!value || value.startsWith('-')) throw new Error(`--${separateSelector} requires a value`)
      if (selector && selector !== separateSelector) throw new Error('--target and --exclude cannot be combined')
      selector = separateSelector
      selectedComponents.add(value)
      index += 1
      continue
    }

    const inlineSelector = args[index].match(/^--(target|exclude)=(.*)$/)
    if (inlineSelector) {
      const [, nextSelector, value] = inlineSelector
      if (!value) throw new Error(`--${nextSelector} requires a value`)
      if (selector && selector !== nextSelector) throw new Error('--target and --exclude cannot be combined')
      selector = nextSelector
      selectedComponents.add(value)
    }
  }

  if (selector === 'target') return !selectedComponents.has(component)
  if (selector === 'exclude') return selectedComponents.has(component)
  return false
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
