// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { DeploymentConfigStore } from './deployment-config-store.mjs'
import {
  deploymentConfigCurrentParameter,
  deploymentConfigReleaseParameter,
} from './deployment-config.mjs'
import { resolveAwsRegion } from './deployment-environment.mjs'
import { resolveAwsCliPath } from './proxy-deployment-verify.mjs'

const RELEASE_ID = /^[0-9a-f]{64}$/

function parseOptions(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    const separatedName = argument.match(/^--(stage|release)$/)?.[1]
    const inline = argument.match(/^--(stage|release)=(.*)$/)
    if (separatedName) {
      const value = args[index + 1]
      if (!value || value.startsWith('-')) throw new Error(`--${separatedName} requires a value`)
      if (options[separatedName] !== undefined) throw new Error(`--${separatedName} may be specified only once`)
      options[separatedName] = value
      index += 1
      continue
    }
    if (inline) {
      const [, inlineName, value] = inline
      if (!value) throw new Error(`--${inlineName} requires a value`)
      if (options[inlineName] !== undefined) throw new Error(`--${inlineName} may be specified only once`)
      options[inlineName] = value
      continue
    }
    throw new Error(`unknown argument '${argument}'`)
  }
  if (!options.stage) throw new Error('--stage is required')

  // Validate path components before constructing the store or authenticating
  // to AWS. An omitted release intentionally means resolve /current once.
  deploymentConfigCurrentParameter(options.stage)
  if (options.release) deploymentConfigReleaseParameter(options.stage, options.release)
  return { stage: options.stage, releaseId: options.release }
}

export function runDeploymentConfigResolve(
  args,
  {
    environment = process.env,
    createStore = (options) => new DeploymentConfigStore(options),
    output = process.stdout,
  } = {},
) {
  const selection = parseOptions(args)
  const region = resolveAwsRegion(environment)
  const store = createStore({ awsCliPath: resolveAwsCliPath(environment), region })
  const result = store.resolve(selection)
  if (!RELEASE_ID.test(result?.releaseId ?? '')) {
    throw new Error('deployment config store returned an invalid SHA-256 release id')
  }
  output.write(`${result.releaseId}\n`)
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    runDeploymentConfigResolve(process.argv.slice(2))
  } catch (error) {
    console.error(`deployment-config-resolve: ${error.message}`)
    process.exitCode = 1
  }
}
