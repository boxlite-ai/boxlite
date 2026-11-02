import { BadRequestException } from '@nestjs/common'

export interface BoxResources {
  cpus: number
  memory_mib: number
  max_cpus: number
  max_memory_mib: number
}

export interface ResizeTarget {
  cpus: number
  memory_mib: number
}

export interface ResizePayload extends ResizeTarget {
  version: 1
  previous: ResizeTarget
}

/** Resize retries are bounded so terminal failure can release the lifecycle fence. */
export const RESIZE_MAX_ATTEMPTS = 10
export const RESIZE_MAX_DURATION_MINUTES = 30
export const RESIZE_TERMINAL_GRACE_MS = 2 * 60 * 1000
export const RESIZE_LEASE_MS = 120_000
/** Bound row-lock waits so one contended Box/Job cannot stall the reaper. */
export const RESIZE_LOCK_TIMEOUT_MS = 5_000

export function validResources(value: unknown): value is BoxResources {
  if (!value || typeof value !== 'object') return false
  const r = value as BoxResources
  return (
    Number.isFinite(r.cpus) &&
    r.cpus >= 0.125 &&
    Math.round(r.cpus * 1000) / 1000 === r.cpus &&
    [r.memory_mib, r.max_cpus, r.max_memory_mib].every((n) => Number.isSafeInteger(n) && n > 0) &&
    r.cpus <= r.max_cpus &&
    r.max_cpus <= 255 &&
    r.memory_mib <= r.max_memory_mib &&
    r.max_memory_mib <= 0xffffffff
  )
}

export function resizeTarget(request: Partial<ResizeTarget>, current: BoxResources): ResizeTarget {
  const target = {
    cpus: request.cpus ?? current.cpus,
    memory_mib: request.memory_mib === undefined ? current.memory_mib : Math.ceil(request.memory_mib / 1024) * 1024,
  }
  if (
    target.cpus < current.cpus ||
    target.memory_mib < current.memory_mib ||
    target.cpus > current.max_cpus ||
    target.memory_mib > current.max_memory_mib
  ) {
    throw new BadRequestException('Resize must grow within the current boot ceilings after cloud memory rounding')
  }
  return target
}
