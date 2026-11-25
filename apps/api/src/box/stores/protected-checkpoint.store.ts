import { ServiceUnavailableException } from '@nestjs/common'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { EntityManager } from 'typeorm'
import type { RunnerContext } from '../../common/interfaces/runner-context.interface'
import type { CheckpointArchive } from '../entities/checkpoint.entity'
import type { CompleteOutboundSnapshot } from '../runner-adapter/outbound-control'

export type CheckpointWriterIdentity = {
  provider: string
  project: string
  zone: string
  instanceId: string
  workDiskIds: string[]
}

export type CheckpointJobOwner = {
  lease_id: string
  release: string
  writer: CheckpointWriterIdentity
}

export type ProtectedCheckpointPayload = CheckpointJobOwner & {
  checkpointId: string
  arcPath: string
  captureOutbound: CompleteOutboundSnapshot
  sourceGeneration?: number
  archive?: CheckpointArchive
  restore?: {
    operationId: string
    targetSequence: number
    targetBoxId: string
    mode: 'create'
    platformEnv: Record<string, string>
    targetOutbound: CompleteOutboundSnapshot
  }
}

type Enrollment = CheckpointJobOwner & { phase: string; expired: boolean; retiring: boolean; retirement: unknown }

function writerIdentity(value: unknown): value is CheckpointWriterIdentity {
  if (!value || typeof value !== 'object') return false
  const { provider, project, zone, instanceId, workDiskIds } = value as CheckpointWriterIdentity
  const validName = (name: unknown) => typeof name === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(name)
  return (
    validName(provider) &&
    validName(project) &&
    validName(zone) &&
    validName(instanceId) &&
    Array.isArray(workDiskIds) &&
    workDiskIds.length > 0 &&
    workDiskIds.every(validName) &&
    new Set(workDiskIds).size === workDiskIds.length
  )
}

export async function checkpointEnrollment(
  manager: EntityManager,
  runnerId: string,
  authentication?: { runner: RunnerContext; token: string },
): Promise<Enrollment | null> {
  const [control] = await manager.query(
    `SELECT phase, minimum_release FROM complete_outbound_admission
     WHERE id = 1 AND api_principal = current_user FOR SHARE`,
  )
  if (!control?.minimum_release || control.phase === 'downgrading') return null
  const values = [runnerId, control.minimum_release]
  if (authentication) {
    values.push(authentication.runner.runner.apiKey, createHash('sha256').update(authentication.token).digest('hex'))
  }
  const [enrollment] = await manager.query(
    `SELECT e.lease_id, e.verified_floor AS release, e.protected_checkpoint_identity AS writer,
        e.protected_checkpoint_retirement AS retirement, e.protected_checkpoint_retirement IS NOT NULL AS retiring,
        e.expires_at <= clock_timestamp() AS expired
     FROM complete_outbound_runner_enrollment e JOIN "runner" r ON r.id = e.runner_id
     WHERE e.runner_id = $1 AND e.verified_floor = $2 AND r."apiVersion" = '2'
        AND e.runner_key_sha256 = encode(sha256(convert_to(r."apiKey", 'UTF8')), 'hex')
        ${authentication ? 'AND r."apiKey" = $3 AND e.token_sha256 = $4' : ''}
     FOR SHARE OF r`,
    values,
  )
  if (!enrollment || !writerIdentity(enrollment.writer)) return null
  return { ...enrollment, phase: control.phase }
}

export async function requireProtectedCheckpointOwner(
  manager: EntityManager,
  runnerId: string,
): Promise<CheckpointJobOwner> {
  const owner = await checkpointEnrollment(manager, runnerId)
  if (!owner || owner.expired || owner.phase !== 'open' || owner.retiring) {
    throw new ServiceUnavailableException('Runner has no current protected checkpoint enrollment under open admission')
  }
  return { lease_id: owner.lease_id, release: owner.release, writer: owner.writer }
}

export function ownsProtectedCheckpoint(
  owner: CheckpointJobOwner,
  enrollment: Enrollment | null,
): enrollment is Enrollment {
  return (
    enrollment !== null &&
    owner.lease_id === enrollment.lease_id &&
    owner.release === enrollment.release &&
    isDeepStrictEqual(owner.writer, enrollment.writer)
  )
}

export function verifiedCheckpointRetirement(enrollment: Enrollment): boolean {
  if (enrollment.writer.provider !== 'gcp' || !enrollment.retirement || typeof enrollment.retirement !== 'object') {
    return false
  }
  const receipt = enrollment.retirement as { instance?: unknown; disks?: unknown[] }
  const { project, zone, instanceId, workDiskIds } = enrollment.writer
  const retired = (value: unknown, id: string, resource: string) => {
    if (!value || typeof value !== 'object') return false
    const operation = value as {
      project?: string
      zone?: string
      targetId?: string
      targetLink?: string
      status?: string
      error?: unknown
      operationType?: string
    }
    return (
      operation.project === project &&
      operation.zone === zone &&
      operation.targetId === id &&
      operation.status === 'DONE' &&
      !operation.error &&
      operation.operationType === 'delete' &&
      typeof operation.targetLink === 'string' &&
      operation.targetLink.includes(`/projects/${project}/zones/${zone}/${resource}/`)
    )
  }
  return (
    retired(receipt.instance, instanceId, 'instances') &&
    Array.isArray(receipt.disks) &&
    workDiskIds.every((id) => receipt.disks!.some((disk) => retired(disk, id, 'disks')))
  )
}
