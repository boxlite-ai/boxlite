import { BadRequestException } from '@nestjs/common'

interface MemoryAllocation {
  mem: number
  memoryMib?: number | null
}

/** Null also covers rows and checkpoint environments written before the MiB column. */
export function memoryMibOf(box: MemoryAllocation): number {
  return box.memoryMib ?? box.mem * 1024
}

export function memoryGiBOf(box: MemoryAllocation): number {
  return memoryMibOf(box) / 1024
}

export function requestedMemoryMib(gib: number): number {
  const mib = gib * 1024
  if (!Number.isInteger(mib) || mib < 128 || mib > 2147483647) {
    throw new BadRequestException('Memory must represent whole MiB between 128 and 2147483647')
  }
  return mib
}
