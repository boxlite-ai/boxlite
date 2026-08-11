// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { validateDeploymentConfigStage } from './deployment-config.mjs'

const COMMANDS = Object.freeze({
  diff: {
    needsDeploymentConfig: true,
    needsProviderCredentials: true,
    needsStackPreflight: true,
    needsRunnerStateBaseline: true,
  },
  deploy: {
    needsDeploymentConfig: true,
    needsProviderCredentials: true,
    needsStackPreflight: true,
    needsRunnerStateBaseline: true,
  },
  remove: {
    needsDeploymentConfig: true,
    needsProviderCredentials: true,
    needsStackPreflight: false,
    needsRunnerStateBaseline: true,
  },
  refresh: {
    needsDeploymentConfig: true,
    needsProviderCredentials: true,
    needsStackPreflight: false,
    needsRunnerStateBaseline: true,
  },
  shell: {
    needsDeploymentConfig: true,
    needsProviderCredentials: true,
    needsStackPreflight: false,
    needsRunnerStateBaseline: true,
  },
  install: {
    needsDeploymentConfig: false,
    needsProviderCredentials: false,
    needsStackPreflight: false,
    needsRunnerStateBaseline: false,
  },
  secret: {
    needsDeploymentConfig: false,
    needsProviderCredentials: false,
    needsStackPreflight: false,
    needsRunnerStateBaseline: false,
  },
  unlock: {
    needsDeploymentConfig: false,
    needsProviderCredentials: false,
    needsStackPreflight: false,
    needsRunnerStateBaseline: false,
  },
  version: {
    needsDeploymentConfig: false,
    needsProviderCredentials: false,
    needsStackPreflight: false,
    needsRunnerStateBaseline: false,
  },
})

export function validateSstSecretMutationArgs(args, environment = process.env) {
  if (!Array.isArray(args) || args[0] !== 'secret' || !['set', 'remove'].includes(args[1])) {
    throw new Error('expected an SST secret set/remove mutation')
  }
  const operation = args[1]
  const name = args[2]
  if (!name || name.startsWith('-')) throw new Error(`sst secret ${operation} requires a secret name`)

  let stage
  let confirmation
  for (let index = 3; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--stage') {
      const value = args[index + 1]
      if (!value || value.startsWith('-')) throw new Error('SST secret mutation --stage requires a value')
      if (stage !== undefined) throw new Error('SST secret mutation requires exactly one explicit --stage')
      stage = validateDeploymentConfigStage(value)
      index += 1
      continue
    }
    const inlineStage = argument.match(/^--stage=(.*)$/)?.[1]
    if (inlineStage !== undefined) {
      if (!inlineStage) throw new Error('SST secret mutation --stage requires a value')
      if (stage !== undefined) throw new Error('SST secret mutation requires exactly one explicit --stage')
      stage = validateDeploymentConfigStage(inlineStage)
      continue
    }
    if (argument === '--confirm') {
      const value = args[index + 1]
      if (!value || value.startsWith('-')) throw new Error('SST secret mutation --confirm requires a value')
      if (confirmation !== undefined) throw new Error('SST secret mutation accepts at most one --confirm')
      confirmation = value
      index += 1
      continue
    }
    if (argument === '--fallback' || argument.startsWith('--fallback=')) {
      throw new Error('SST secret --fallback is disabled; set the exact stage value through stdin')
    }
    if (argument.startsWith('-')) {
      throw new Error('unknown options are not allowed for SST secret mutations')
    }
    throw new Error('positional SST secret values are disabled; provide the value through stdin')
  }

  if (stage === undefined) {
    throw new Error('SST secret mutation requires exactly one explicit --stage or --stage=<stage>')
  }
  const ambientStage = environment.SST_STAGE
  if (ambientStage !== undefined && ambientStage !== '' && ambientStage !== stage) {
    throw new Error('ambient SST_STAGE conflicts with the explicit SST secret mutation stage')
  }

  return {
    operation,
    name,
    stage,
    confirmation,
    sstArgs: ['secret', operation, name, '--stage', stage],
  }
}

export function classifySstCommand(args) {
  if (!Array.isArray(args) || !args[0]) throw new Error('an SST subcommand is required')
  if (args[0].startsWith('-')) throw new Error('the SST subcommand must be the first argument')
  if (args[0] === 'dev') throw new Error('sst dev is disabled for this stateful stack')
  const contract = COMMANDS[args[0]]
  if (!contract) throw new Error(`unknown or unsupported SST subcommand '${args[0]}'; classify it before use`)
  if (args[0] === 'secret' && (!args[1] || args[1].startsWith('-'))) {
    throw new Error('sst secret requires an explicit subcommand')
  }
  if (args[0] === 'secret' && args[1] === 'list') {
    throw new Error('raw sst secret list is disabled because it prints values; use the names-and-set-state inspector')
  }
  if (args[0] === 'secret' && args[1] === 'load') {
    throw new Error('sst secret load is disabled because bulk writes bypass per-name safe status metadata')
  }
  if (args[0] === 'secret' && !['set', 'remove'].includes(args[1])) {
    throw new Error(`unknown or unsupported SST secret subcommand '${args[1]}'`)
  }
  return { subcommand: args[0], ...contract }
}
