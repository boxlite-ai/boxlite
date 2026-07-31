// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PARTIAL_DEPLOY_SELECTOR = /^--(?:target|exclude)(?:=|$)/
const RUNNER_POLICY_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const RUNNER_POLICY_SUBCOMMANDS = new Set(['diff', 'deploy'])

export function requireSstSubcommandFirst(args) {
  if (!args[0] || args[0].startsWith('-')) {
    throw new Error('the SST subcommand must be the first argument so deployment safety checks cannot be bypassed')
  }
  if (args[0] === 'dev') {
    throw new Error('sst dev is disabled for this stateful stack; use a fresh guarded diff and deploy instead')
  }
  if (RUNNER_POLICY_SUBCOMMANDS.has(args[0]) && args.includes('--')) {
    throw new Error('the -- argument delimiter is disabled for guarded SST diff and deploy commands')
  }
}

export function requireFullStackDeploy(args) {
  if (args[0] !== 'deploy') return

  const selector = args.find((argument) => PARTIAL_DEPLOY_SELECTOR.test(argument))
  if (selector) {
    throw new Error(
      `partial SST deploys are disabled (${selector}); run a full deploy so provider state and resources reconcile together`,
    )
  }
}

export function withRequiredRunnerPolicy(args, workingDirectory = process.cwd()) {
  if (!RUNNER_POLICY_SUBCOMMANDS.has(args[0])) return [...args]

  const policyArguments = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--policy') {
      const value = args[index + 1]
      const hasValue = value !== undefined && !value.startsWith('--')
      policyArguments.push({ index, valueIndex: hasValue ? index + 1 : undefined, value: hasValue ? value : undefined })
      if (hasValue) index += 1
    } else if (argument.startsWith('--policy=')) {
      policyArguments.push({ index, value: argument.slice('--policy='.length) })
    }
  }

  if (policyArguments.length > 1) {
    throw new Error('the Runner policy must be specified exactly once')
  }
  if (policyArguments.length === 0) {
    return [...args, '--policy', RUNNER_POLICY_ROOT]
  }

  const [policyArgument] = policyArguments
  if (!policyArgument.value || resolve(workingDirectory, policyArgument.value) !== RUNNER_POLICY_ROOT) {
    throw new Error(`the Runner policy path must be ${RUNNER_POLICY_ROOT}`)
  }

  const normalizedArgs = [...args]
  if (policyArgument.valueIndex === undefined) {
    normalizedArgs[policyArgument.index] = `--policy=${RUNNER_POLICY_ROOT}`
  } else {
    normalizedArgs[policyArgument.valueIndex] = RUNNER_POLICY_ROOT
  }
  return normalizedArgs
}
