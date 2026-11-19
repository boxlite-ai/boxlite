/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { X509Certificate } from 'node:crypto'
import { Agent } from 'node:https'
import { isIP } from 'node:net'
import type { Runner } from '../entities/runner.entity'

type Enrollment = { runnerId: string; url: string; caPem: string }

export function enrolledRunnerAgent(runner: Pick<Runner, 'id' | 'apiUrl'>): Agent | undefined {
  const configured = process.env.BOXLITE_PROTECTED_PROXY_ENROLLMENTS
  if (!configured) return undefined
  const records: Enrollment[] = JSON.parse(configured)
  if (!Array.isArray(records)) throw new Error('Invalid protected Runner enrollment list')
  const matches = records.filter((record) => record.runnerId === runner.id)
  if (matches.length === 0) return undefined
  if (matches.length !== 1 || !runner.apiUrl) throw new Error('Invalid protected Runner enrollment')
  const enrollment = matches[0]
  const url = new URL(enrollment.url)
  if (
    url.protocol !== 'https:' ||
    isIP(url.hostname.replace(/^\[|\]$/g, '')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    url.href !== new URL(runner.apiUrl).href ||
    !new X509Certificate(enrollment.caPem).ca
  ) {
    throw new Error('Protected Runner endpoint does not match its HTTPS enrollment')
  }
  return new Agent({ ca: enrollment.caPem, rejectUnauthorized: true })
}

export type ProtectedBootKey = {
  runner_id: string
  attempt_id: string
  registration_id: string
  registration_revision: string
  policy: { policy: { mode: 'enabled' | 'disabled'; allow_net: string[] }; revision: string }
}

export type ProtectedBootRoute = {
  scheme: 'http' | 'https' | 'socks5'
  host: string
  port: number
  credential?: { username: string; password: string }
}

export type ProtectedBootReceipt = { key: ProtectedBootKey; epoch: string | null; outcome: 'confirmed' | 'retired' }

export function checkedBootReceipt(
  value: unknown,
  boxId: string,
  expected: ProtectedBootKey,
  expectedEpoch?: string,
): ProtectedBootReceipt {
  const response = value as { box_id?: string; receipt?: ProtectedBootReceipt } | null
  const receipt = response?.receipt
  const key = receipt?.key
  const allowNet = key?.policy?.policy?.allow_net
  const expectedAllowNet = expected.policy.policy.allow_net
  if (
    response?.box_id !== boxId ||
    !receipt ||
    !key ||
    key.runner_id !== expected.runner_id ||
    key.attempt_id !== expected.attempt_id ||
    key.registration_id !== expected.registration_id ||
    key.registration_revision !== expected.registration_revision ||
    key.policy?.revision !== expected.policy.revision ||
    key.policy?.policy?.mode !== expected.policy.policy.mode ||
    !Array.isArray(allowNet) ||
    allowNet.length !== expectedAllowNet.length ||
    allowNet.some((rule, index) => rule !== expectedAllowNet[index]) ||
    (receipt.outcome !== 'confirmed' && receipt.outcome !== 'retired') ||
    (expectedEpoch !== undefined && receipt.epoch !== expectedEpoch) ||
    (receipt.epoch === null
      ? receipt.outcome !== 'retired'
      : typeof receipt.epoch !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(receipt.epoch))
  ) {
    throw new Error('Runner did not return exact protected bootstrap evidence')
  }
  return { key: expected, epoch: receipt.epoch, outcome: receipt.outcome }
}
