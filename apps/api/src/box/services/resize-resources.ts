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

export function validResources(value: unknown): value is BoxResources {
  if (!value || typeof value !== 'object') return false
  const r = value as BoxResources
  return (
    [r.cpus, r.memory_mib, r.max_cpus, r.max_memory_mib].every((n) => Number.isSafeInteger(n) && n > 0) &&
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
