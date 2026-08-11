// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

import {
  canonicalizeDeploymentConfig,
  createDeploymentConfigDocument,
  deploymentConfigCurrentParameter,
  deploymentConfigReleaseId,
  deploymentConfigReleaseParameter,
  parseDeploymentConfigRelease,
  validateDeploymentConfigStage,
} from './deployment-config.mjs'

const DEPLOYMENT_OPERATION_LOCK_OWNER_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const DEPLOYMENT_OPERATION_LOCK_OWNER_ENV = 'BOXLITE_DEPLOYMENT_OPERATION_LOCK_OWNER'

export function deploymentOperationLockParameter(stage) {
  validateDeploymentConfigStage(stage)
  return `/boxlite/${stage}/deployment-operation-lock`
}

function validateDeploymentOperationLockOwner(ownerId) {
  if (typeof ownerId !== 'string' || !DEPLOYMENT_OPERATION_LOCK_OWNER_PATTERN.test(ownerId)) {
    throw new Error('deployment operation lock owner must be a lowercase UUID v4')
  }
  return ownerId
}

function awsErrorIs(error, code) {
  return error?.code === code || new RegExp(code, 'i').test(`${error?.stderr ?? ''}\n${error?.message ?? ''}`)
}

function parseAwsJson(source, operation) {
  try {
    return JSON.parse(source)
  } catch (cause) {
    throw new Error(`AWS ${operation} returned invalid JSON`, { cause })
  }
}

export class DeploymentConfigStore {
  constructor({ awsCliPath, region, executeAws } = {}) {
    if (typeof awsCliPath !== 'string' || !awsCliPath) throw new Error('deployment config store requires awsCliPath')
    if (typeof region !== 'string' || !region) throw new Error('deployment config store requires region')
    this.awsCliPath = awsCliPath
    this.region = region
    this.executeAws =
      executeAws ??
      (({ args, input }) =>
        execFileSync(this.awsCliPath, args, {
          encoding: 'utf8',
          input,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30_000,
          killSignal: 'SIGTERM',
          maxBuffer: 1024 * 1024,
        }))
  }

  aws(args, input) {
    return this.executeAws({
      args: [...args, '--region', this.region, '--no-cli-pager'],
      input,
    })
  }

  identity() {
    let result
    try {
      result = parseAwsJson(
        this.aws(['sts', 'get-caller-identity', '--output', 'json']),
        'sts get-caller-identity',
      )
    } catch (cause) {
      throw new Error('could not resolve the AWS account for deployment config', { cause })
    }
    if (!/^\d{12}$/.test(result.Account ?? '')) {
      throw new Error('AWS sts get-caller-identity returned no 12-digit Account')
    }
    return result
  }

  getParameter(name) {
    let result
    try {
      result = parseAwsJson(
        this.aws(['ssm', 'get-parameter', '--name', name, '--output', 'json']),
        'ssm get-parameter',
      )
    } catch (cause) {
      throw Object.assign(new Error(`could not read deployment config parameter ${name}`, { cause }), {
        code: cause?.code,
      })
    }
    const value = result.Parameter?.Value
    if (typeof value !== 'string') throw new Error(`deployment config parameter ${name} returned no string value`)
    return value
  }

  putRelease(name, source) {
    try {
      this.aws(
        [
          'ssm',
          'put-parameter',
          '--name',
          name,
          '--description',
          'Immutable BoxLite deployment configuration release',
          '--type',
          'String',
          '--tier',
          'Standard',
          '--value',
          'file:///dev/stdin',
          '--output',
          'json',
        ],
        source,
      )
    } catch (error) {
      if (!awsErrorIs(error, 'ParameterAlreadyExists')) {
        throw new Error(`could not publish immutable deployment config parameter ${name}`, { cause: error })
      }
    }

    const storedSource = this.getParameter(name)
    if (storedSource !== source) {
      throw new Error(`existing immutable deployment config ${name} has different bytes`)
    }
  }

  putCurrent(stage, releaseId) {
    const name = deploymentConfigCurrentParameter(stage)
    try {
      this.aws(
        [
          'ssm',
          'put-parameter',
          '--name',
          name,
          '--description',
          'Current immutable BoxLite deployment configuration release',
          '--type',
          'String',
          '--tier',
          'Standard',
          '--value',
          'file:///dev/stdin',
          '--overwrite',
          '--output',
          'json',
        ],
        releaseId,
      )
    } catch (cause) {
      throw new Error(`could not activate deployment config release ${releaseId}`, { cause })
    }
    return this.getParameter(name) === releaseId
  }

  acquireDeploymentOperationLock({ stage, ownerId = randomUUID() } = {}) {
    const name = deploymentOperationLockParameter(stage)
    validateDeploymentOperationLockOwner(ownerId)
    try {
      this.aws(
        [
          'ssm',
          'put-parameter',
          '--name',
          name,
          '--description',
          'Exclusive BoxLite deployment operation lock',
          '--type',
          'String',
          '--tier',
          'Standard',
          '--value',
          'file:///dev/stdin',
          '--output',
          'json',
        ],
        ownerId,
      )
    } catch (cause) {
      if (awsErrorIs(cause, 'ParameterAlreadyExists')) {
        throw new Error(
          `a deployment operation for stage ${stage} is already in progress; if no bootstrap, config activation, preview, or deploy owns it, delete ${name} in ${this.region} deliberately and retry`,
        )
      }
      throw new Error(`could not acquire the deployment operation lock for stage ${stage}`, { cause })
    }
    return Object.freeze({ name, ownerId, stage })
  }

  assertDeploymentOperationLockOwner({ stage, ownerId } = {}) {
    const name = deploymentOperationLockParameter(stage)
    validateDeploymentOperationLockOwner(ownerId)
    let currentOwner
    try {
      currentOwner = this.getParameter(name)
    } catch {
      throw new Error(`the inherited deployment operation lock for stage ${stage} is unavailable`)
    }
    if (currentOwner !== ownerId) {
      throw new Error(`the inherited deployment operation lock for stage ${stage} has a different owner`)
    }
    return Object.freeze({ name, ownerId, stage })
  }

  releaseDeploymentOperationLock(lock) {
    if (!lock || typeof lock !== 'object') throw new Error('deployment operation lock handle is required')
    const name = deploymentOperationLockParameter(lock.stage)
    validateDeploymentOperationLockOwner(lock.ownerId)
    if (lock.name !== name) throw new Error('deployment operation lock handle has the wrong parameter name')

    const currentOwner = this.getParameter(name)
    if (currentOwner !== lock.ownerId) {
      throw new Error(`deployment operation lock ownership changed for stage ${lock.stage}; refusing to delete another owner lock`)
    }
    try {
      this.aws(['ssm', 'delete-parameter', '--name', name, '--output', 'json'])
    } catch (cause) {
      throw new Error(`could not release the deployment operation lock for stage ${lock.stage}`, { cause })
    }
  }

  async withDeploymentOperationLock(options, operation) {
    if (typeof operation !== 'function') throw new Error('deployment operation lock callback is required')
    const lock = this.acquireDeploymentOperationLock(options)
    try {
      return await operation()
    } finally {
      this.releaseDeploymentOperationLock(lock)
    }
  }

  readRelease({ stage, releaseId, accountId }) {
    const name = deploymentConfigReleaseParameter(stage, releaseId)
    let source
    try {
      source = this.getParameter(name)
    } catch (cause) {
      throw new Error(`could not load deployment config release ${releaseId}`, { cause })
    }
    return parseDeploymentConfigRelease(source, {
      releaseId,
      stage,
      region: this.region,
      accountId,
    })
  }

  prepare({ stage, environment, configuredKeys, runtimeSecretGenerations }) {
    const identity = this.identity()
    const document = createDeploymentConfigDocument({
      environment,
      configuredKeys,
      stage,
      region: this.region,
      accountId: identity.Account,
      runtimeSecretGenerations,
    })
    return this.prepareBoundDocument(document, identity.Account)
  }

  prepareDocument({ document }) {
    const identity = this.identity()
    return this.prepareBoundDocument(document, identity.Account)
  }

  prepareBoundDocument(document, accountId) {
    const source = canonicalizeDeploymentConfig(document)
    const releaseId = deploymentConfigReleaseId(source)
    const name = deploymentConfigReleaseParameter(document.stage, releaseId)

    // Verify every account/region/stage binding before the immutable write. A
    // rejected rebase must not leave even an unreachable malformed release.
    parseDeploymentConfigRelease(source, {
      releaseId,
      stage: document.stage,
      region: this.region,
      accountId,
    })

    this.putRelease(name, source)
    return this.readRelease({ stage: document.stage, releaseId, accountId })
  }

  publish(input) {
    const prepared = this.prepare(input)
    return this.activate({ stage: input.stage, releaseId: prepared.releaseId })
  }

  resolve({ stage, releaseId } = {}) {
    const identity = this.identity()
    let selectedReleaseId = releaseId
    if (selectedReleaseId === undefined || selectedReleaseId === '') {
      selectedReleaseId = this.getParameter(deploymentConfigCurrentParameter(stage))
      // Validate the pointer before interpolating it into another SSM path.
      deploymentConfigReleaseParameter(stage, selectedReleaseId)
    }
    return this.readRelease({ stage, releaseId: selectedReleaseId, accountId: identity.Account })
  }

  activate({ stage, releaseId }) {
    const identity = this.identity()
    const verified = this.readRelease({ stage, releaseId, accountId: identity.Account })
    const isCurrent = this.putCurrent(stage, releaseId)
    return { ...verified, isCurrent }
  }
}
