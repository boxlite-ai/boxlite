// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { DeploymentConfigStore } from './deployment-config-store.mjs'
import { resolveAwsRegion } from './deployment-environment.mjs'
import { resolveAwsCliPath } from './proxy-deployment-verify.mjs'
import {
  assertRuntimeSecretGenerationsCurrent,
  readRuntimeSecretGenerations,
} from './runtime-secret-generation-guard.mjs'

function parseOptions(args) {
  const options = {}
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--rebase-runtime-generations') {
      if (options.rebaseRuntimeGenerations) {
        throw new Error('--rebase-runtime-generations may be specified only once')
      }
      options.rebaseRuntimeGenerations = true
      continue
    }
    const name = argument.match(/^--(stage|release)$/)?.[1]
    const inline = argument.match(/^--(stage|release)=(.*)$/)
    if (name) {
      const candidate = args[index + 1]
      if (!candidate || candidate.startsWith('-')) throw new Error(`--${name} requires a value`)
      if (options[name] !== undefined) throw new Error(`--${name} may be specified only once`)
      options[name] = candidate
      index += 1
      continue
    }
    if (inline) {
      const [, inlineName, candidate] = inline
      if (!candidate) throw new Error(`--${inlineName} requires a value`)
      if (options[inlineName] !== undefined) throw new Error(`--${inlineName} may be specified only once`)
      options[inlineName] = candidate
      continue
    }
    throw new Error(`unknown argument '${argument}'`)
  }
  if (!options.stage) throw new Error('--stage is required')
  if (!options.release) throw new Error('--release is required')
  return { ...options, rebaseRuntimeGenerations: options.rebaseRuntimeGenerations === true }
}

export async function activateDeploymentConfig(
  args,
  environment = process.env,
  {
    createStore = (options) => new DeploymentConfigStore(options),
    resolveAwsCli = resolveAwsCliPath,
    assertGenerations = assertRuntimeSecretGenerationsCurrent,
    readGenerations = readRuntimeSecretGenerations,
    log = console.log,
  } = {},
) {
  const { stage, release: releaseId, rebaseRuntimeGenerations } = parseOptions(args)
  const region = resolveAwsRegion(environment)
  const awsCliPath = resolveAwsCli(environment)
  const store = createStore({ awsCliPath, region })
  const result = await store.withDeploymentOperationLock({ stage }, async () => {
    const selected = store.resolve({ stage, releaseId })
    if (rebaseRuntimeGenerations) {
      const runtimeSecretGenerations = readGenerations({ stage, region, awsCliPath })
      const prepared = store.prepareDocument({
        document: {
          ...selected.document,
          values: {
            ...selected.document.values,
            BOXLITE_RUNTIME_SECRET_GENERATIONS: runtimeSecretGenerations,
          },
        },
      })
      const activated = store.activate({ stage, releaseId: prepared.releaseId })
      return { ...activated, sourceReleaseId: selected.releaseId }
    }
    try {
      assertGenerations({
        stage,
        region,
        awsCliPath,
        expectedGenerations: selected.document.values.BOXLITE_RUNTIME_SECRET_GENERATIONS,
      })
    } catch (error) {
      if (!/runtime secret generations do not match the pinned deployment config/i.test(error.message)) throw error
      throw new Error(
        'runtime secret generations do not match the selected historical release; rerun with --rebase-runtime-generations to create and activate a new immutable release',
      )
    }
    return store.activate({ stage, releaseId })
  })
  if (result.sourceReleaseId) {
    log(
      `[deployment-config] rebased source ${result.sourceReleaseId} to ${result.releaseId}; ` +
        `${result.isCurrent ? 'new release is current' : 'another concurrent pointer update won'} for ${stage} in ${region}`,
    )
  } else {
    log(
      `[deployment-config] ${result.releaseId} ${result.isCurrent ? 'is current' : 'lost a concurrent pointer update'} ` +
        `for ${stage} in ${region}`,
    )
  }
  // Activation means the release is current. A pointer write whose readback
  // disagreed changed nothing, so returning normally would tell the operator —
  // and any workflow reading the exit status — that a rollback took effect when
  // it did not. Log first: the losing release id is what makes it diagnosable.
  if (!result.isCurrent) {
    throw new Error(
      `release ${result.releaseId} did not become current for ${stage} in ${region}; ` +
        'another writer moved the pointer, so nothing was activated — rerun to retry',
    )
  }
  return result
}

// Compare resolved real paths, as deployment-config-resolve.mjs does: Node
// absolutizes process.argv[1] but leaves its symlinks intact, so a run reached
// through a symlinked worktree would otherwise skip this block and exit 0
// without activating anything.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await activateDeploymentConfig(process.argv.slice(2))
  } catch (error) {
    console.error(`deployment-config: ${error.message}`)
    process.exitCode = 1
  }
}
