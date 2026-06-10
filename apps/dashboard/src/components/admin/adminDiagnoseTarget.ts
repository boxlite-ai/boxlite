/*
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { AdminObservabilityBaseParams } from '@/hooks/useAdminObservability'
import type { AdminBox, AdminMachine, AdminRunner, OwnerGroup } from './adminHelpers'

export type AdminDiagnoseTargetKind =
  | 'box'
  | 'runner'
  | 'machine'
  | 'trace'
  | 'execution'
  | 'job'
  | 'request'
  | 'org'
  | 'user'

export interface AdminDiagnoseDetail {
  label: string
  value: string
  action?: { type: 'runner'; id: string }
}

export interface AdminDiagnoseTarget {
  kind: AdminDiagnoseTargetKind
  title: string
  subtitle: string
  state?: string
  details: AdminDiagnoseDetail[]
  params: Partial<Omit<AdminObservabilityBaseParams, 'from' | 'to' | 'page' | 'limit'>>
  box?: AdminBox
  runner?: AdminRunner
  machine?: AdminMachine
}

export function createBoxDiagnoseTarget(box: AdminBox): AdminDiagnoseTarget {
  return {
    kind: 'box',
    title: 'Diagnose box',
    subtitle: box.boxId ? `${box.boxId} · ${box.id}` : box.id,
    state: box.state,
    box,
    params: {
      orgId: box.organizationId,
      boxId: box.id,
      runnerId: box.runnerId ?? undefined,
    },
    details: [
      { label: 'owner', value: box.owner.name },
      { label: 'org', value: box.owner.personal ? 'personal' : box.owner.orgName },
      box.runnerId
        ? { label: 'runner', value: box.runnerId, action: { type: 'runner', id: box.runnerId } }
        : { label: 'runner', value: 'none' },
      { label: 'specs', value: `${box.cpu}c / ${box.memoryGiB}G` },
      { label: 'created', value: new Date(box.createdAt).toLocaleString() },
    ],
  }
}

export function createOwnerGroupDiagnoseTarget(group: OwnerGroup): AdminDiagnoseTarget {
  const isUserTarget = group.owner.personal && Boolean(group.owner.userId)
  const targetKind: AdminDiagnoseTargetKind = isUserTarget ? 'user' : 'org'
  const params: AdminDiagnoseTarget['params'] = {
    orgId: group.organizationId,
    ...(isUserTarget ? { userId: group.owner.userId } : {}),
  }

  return {
    kind: targetKind,
    title: isUserTarget ? 'Diagnose user' : 'Diagnose org',
    subtitle: isUserTarget ? `${group.owner.name} · ${group.organizationId}` : group.owner.orgName,
    state: `${group.boxes.length} box${group.boxes.length === 1 ? '' : 'es'}`,
    params,
    details: [
      { label: isUserTarget ? 'user' : 'org', value: group.owner.name },
      { label: 'email', value: group.owner.email || 'none' },
      { label: 'orgId', value: group.organizationId },
      { label: 'boxes', value: String(group.boxes.length) },
    ],
  }
}

export function createRunnerDiagnoseTarget(runner: AdminRunner): AdminDiagnoseTarget {
  return {
    kind: 'runner',
    title: 'Diagnose runner',
    subtitle: runner.id,
    state: runner.draining ? 'draining' : runner.unschedulable ? 'cordoned' : runner.state,
    runner,
    params: {
      runnerId: runner.id,
      machineId: runner.id,
    },
    details: [
      { label: 'runner', value: runner.id },
      { label: 'state', value: runner.state },
      { label: 'scheduling', value: runner.unschedulable ? 'cordoned' : runner.draining ? 'draining' : 'accepting' },
      { label: 'boxes', value: String(runner.currentStartedBoxes) },
      { label: 'cpu alloc', value: `${runner.currentAllocatedCpu}/${runner.cpu}` },
      { label: 'mem alloc', value: `${runner.currentAllocatedMemoryGiB.toFixed(1)}/${runner.memory.toFixed(1)} GiB` },
    ],
  }
}

export function createMachineDiagnoseTarget(machine: AdminMachine): AdminDiagnoseTarget {
  return {
    kind: 'machine',
    title: 'Diagnose machine',
    subtitle: machine.host,
    machine,
    params: {
      machineId: machine.host,
      runnerId: machine.host,
    },
    details: [
      { label: 'host', value: machine.host },
      { label: 'region', value: machine.region },
      { label: 'boxes', value: String(machine.boxes) },
      { label: 'oversell cpu', value: `${machine.oversellCpu.toFixed(1)}x` },
      { label: 'cpu waterline', value: `${machine.cpuWaterline.toFixed(1)}%` },
      { label: 'mem waterline', value: `${machine.memWaterline.toFixed(1)}%` },
    ],
  }
}

export function createTraceDiagnoseTarget(traceId: string): AdminDiagnoseTarget {
  return {
    kind: 'trace',
    title: 'Diagnose trace',
    subtitle: traceId,
    params: { traceId },
    details: [{ label: 'traceId', value: traceId }],
  }
}

export function createExecutionDiagnoseTarget(executionId: string, traceId?: string): AdminDiagnoseTarget {
  return {
    kind: 'execution',
    title: 'Diagnose execution',
    subtitle: executionId,
    params: { executionId, traceId },
    details: [{ label: 'executionId', value: executionId }, ...(traceId ? [{ label: 'traceId', value: traceId }] : [])],
  }
}

export function createJobDiagnoseTarget(jobId: string, traceId?: string): AdminDiagnoseTarget {
  return {
    kind: 'job',
    title: 'Diagnose job',
    subtitle: jobId,
    params: { jobId, traceId },
    details: [{ label: 'jobId', value: jobId }, ...(traceId ? [{ label: 'traceId', value: traceId }] : [])],
  }
}

export function createRequestDiagnoseTarget(requestId: string, traceId?: string): AdminDiagnoseTarget {
  return {
    kind: 'request',
    title: 'Diagnose request',
    subtitle: requestId,
    params: { requestId, traceId },
    details: [{ label: 'requestId', value: requestId }, ...(traceId ? [{ label: 'traceId', value: traceId }] : [])],
  }
}
