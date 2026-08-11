// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import {
  DEPLOYMENT_CONFIG_RELEASE_ENV,
  deploymentConfigCurrentParameter,
  deploymentConfigReleaseParameter,
  injectDeploymentConfigEnvironment,
} from './deployment-config.mjs'
import { DeploymentConfigStore } from './deployment-config-store.mjs'

/*
 * The one routine-deployment composition boundary: resolve one immutable
 * release, then inject that exact document into the child environment. Keeping
 * both operations here lets the selected-ref guard exercise the real ordering
 * without AWS credentials by injecting a fake store.
 */
export function resolveAndInjectDeploymentConfig({
  stage,
  region,
  awsCliPath,
  environment = process.env,
  releaseId,
  createStore = (options) => new DeploymentConfigStore(options),
} = {}) {
  if (!environment || typeof environment !== 'object') {
    throw new Error('deployment config loader requires an environment object')
  }
  const selectedReleaseId = releaseId === undefined ? environment[DEPLOYMENT_CONFIG_RELEASE_ENV] : releaseId
  if (selectedReleaseId !== undefined && typeof selectedReleaseId !== 'string') {
    throw new Error(`${DEPLOYMENT_CONFIG_RELEASE_ENV} must be a string`)
  }
  if (selectedReleaseId !== undefined && selectedReleaseId !== selectedReleaseId.trim()) {
    throw new Error(`${DEPLOYMENT_CONFIG_RELEASE_ENV} must not contain surrounding whitespace`)
  }

  // Validate every SSM path component before constructing a store or touching
  // AWS. Empty means resolve /current exactly once inside the store.
  deploymentConfigCurrentParameter(stage)
  if (selectedReleaseId) deploymentConfigReleaseParameter(stage, selectedReleaseId)

  const store = createStore({ awsCliPath, region })
  if (!store || typeof store.resolve !== 'function') {
    throw new Error('deployment config loader requires a store with resolve()')
  }
  const release = store.resolve({ stage, releaseId: selectedReleaseId || undefined })
  injectDeploymentConfigEnvironment(release, environment)
  return release
}
