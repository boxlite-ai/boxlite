/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { X509Certificate } from 'node:crypto'
import { Agent } from 'node:https'
import { isIP } from 'node:net'
import type { Runner } from '../entities/runner.entity'
import type { Box } from '../entities/box.entity'
import type { BoxVolume } from '../dto/box.dto'
import type { ManagedSnapshot, SealedEvidence } from './protected-outbound'
import { validOutboundRevision, validOutboundSnapshot } from './outbound-control'

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
  registration_id: string | null
  registration_revision: string | null
  policy: { policy: { mode: 'enabled' | 'disabled'; allow_net: string[] }; revision: string }
}

export type ProtectedBootRoute = {
  scheme: 'http' | 'https' | 'socks5'
  host: string
  port: number
  credential?: { username: string; password: string }
}

export type ProtectedBootReceipt = { key: ProtectedBootKey; epoch: string | null; outcome: 'confirmed' | 'retired' }

export type ProtectedBootCapability = 'supported' | 'unsupported' | 'unverified'

export interface ProtectedBootControl {
  supportsProtectedBootstrap(recovery?: boolean, volumeRestart?: boolean): Promise<boolean>
  prepareProtectedBox(
    box: Box,
    image: string,
    metadata: Record<string, string>,
    nestedVirtualization: boolean,
  ): Promise<unknown>
  startProtectedBox(
    boxId: string,
    key: ProtectedBootKey,
    route: ProtectedBootRoute | null,
    generation?: string,
    restart?: boolean,
    restartVolumes?: BoxVolume[],
  ): Promise<ProtectedBootReceipt>
  readProtectedBoot(boxId: string, key: ProtectedBootKey, expectedEpoch?: string): Promise<ProtectedBootReceipt>
  retireProtectedBoot(boxId: string, key: ProtectedBootKey, expectedEpoch?: string): Promise<ProtectedBootReceipt>
  removeRetiredEpoch(boxId: string, key: ProtectedBootKey, epoch: string | null): Promise<ProtectedBootReceipt>
  sealProtectedEpoch(boxId: string, key: ProtectedBootKey, epoch: string, generation: string): Promise<SealedEvidence>
  changeProtectedBootGate(
    boxId: string,
    key: ProtectedBootKey,
    epoch: string,
    generation: string,
    action: 'release' | 'seal',
    outbound?: ManagedSnapshot,
  ): Promise<void>
}

export function validBootstrapIntent(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const input = value as Record<string, unknown>
  const key = input.key as ProtectedBootKey | undefined
  if (
    !key ||
    !validOutboundRevision(key.runner_id) ||
    !validOutboundRevision(key.attempt_id) ||
    !validOutboundRevision(input.generation) ||
    !validOutboundSnapshot(key.policy) ||
    (input.claim !== undefined && !validOutboundRevision(input.claim)) ||
    (input.epoch !== undefined && !validOutboundRevision(input.epoch)) ||
    (input.retiredEpoch !== undefined && input.retiredEpoch !== null && !validOutboundRevision(input.retiredEpoch)) ||
    (input.restart !== undefined && typeof input.restart !== 'boolean')
  )
    return false
  if (input.proxyName === null) return key.registration_id === null && key.registration_revision === null
  return (
    typeof input.proxyName === 'string' &&
    /^[a-z0-9][a-z0-9-]{0,62}$/.test(input.proxyName) &&
    validOutboundRevision(key.registration_id) &&
    typeof key.registration_revision === 'string' &&
    /^[1-9][0-9]{0,9}$/.test(key.registration_revision) &&
    Number(key.registration_revision) <= 2147483647
  )
}

export function checkedBootReceipt(
  value: unknown,
  boxId: string,
  expected: ProtectedBootKey,
  expectedEpoch?: string | null,
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
