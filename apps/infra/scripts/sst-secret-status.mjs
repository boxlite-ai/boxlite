// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { execFileSync } from 'node:child_process'

import {
  SST_APP_SECRET_NAMES,
  STALE_SST_SECRET_NAMES,
  TRACKED_SST_SECRET_NAMES,
  sstSecretStatusParameterName,
} from './runtime-secrets.mjs'
import { validateSstSecretMutationArgs } from './sst-command-contract.mjs'

const SST_SECRET_STATUSES = new Set(['SET', 'UNSET', 'UNKNOWN'])

export function resolveTrackedSstSecretMutation(args) {
  if (args[0] !== 'secret' || !['set', 'remove'].includes(args[1])) return undefined
  const { operation, name, stage, confirmation, sstArgs } = validateSstSecretMutationArgs(args)
  if (!TRACKED_SST_SECRET_NAMES.includes(name)) {
    throw new Error('the SST secret name is not registered for safe status metadata')
  }
  if (operation === 'set' && !SST_APP_SECRET_NAMES.includes(name)) {
    throw new Error(`stale SST secret '${name}' may only be removed`)
  }
  if (operation === 'remove' && STALE_SST_SECRET_NAMES.includes(name)) {
    if (confirmation === undefined) {
      throw new Error(`removing stale SST secret ${name} requires exactly one --confirm ${name}`)
    }
    if (confirmation !== name) {
      throw new Error('--confirm must exactly match the stale SST secret name')
    }
  } else if (confirmation !== undefined) {
    throw new Error('--confirm is accepted only for allowlisted stale SST secret removal')
  }
  return { name, stage, finalStatus: operation === 'set' ? 'SET' : 'UNSET', sstArgs }
}

export class SstSecretStatusStore {
  constructor({ awsCliPath, region, execute = execFileSync }) {
    if (!awsCliPath) throw new Error('AWS CLI path is required for SST secret status metadata')
    if (!region) throw new Error('AWS region is required for SST secret status metadata')
    this.awsCliPath = awsCliPath
    this.region = region
    this.execute = execute
  }

  read({ stage, name }) {
    const parameterName = sstSecretStatusParameterName(stage, name)
    try {
      const status = this.execute(
        this.awsCliPath,
        [
          'ssm',
          'get-parameter',
          '--region',
          this.region,
          '--name',
          parameterName,
          '--query',
          'Parameter.Value',
          '--output',
          'text',
        ],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 15_000,
          killSignal: 'SIGTERM',
        },
      ).trim()
      return SST_SECRET_STATUSES.has(status) ? status : 'UNKNOWN'
    } catch {
      // Missing metadata, access denial, malformed output, and CLI failures all
      // mean the safe inspector cannot establish state. Never surface captured
      // AWS output here: it is untrusted and status must remain names-only.
      return 'UNKNOWN'
    }
  }

  write({ stage, name, status }) {
    if (!SST_SECRET_STATUSES.has(status)) throw new Error(`invalid SST secret status '${status}'`)
    const parameterName = sstSecretStatusParameterName(stage, name)
    try {
      this.execute(
        this.awsCliPath,
        [
          'ssm',
          'put-parameter',
          '--region',
          this.region,
          '--name',
          parameterName,
          '--type',
          'String',
          '--value',
          status,
          '--overwrite',
          '--output',
          'json',
        ],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'ignore', 'pipe'],
          timeout: 15_000,
          killSignal: 'SIGTERM',
        },
      )
    } catch {
      throw new Error(`could not update nonsecret status metadata for SST secret ${name}`)
    }
  }
}
