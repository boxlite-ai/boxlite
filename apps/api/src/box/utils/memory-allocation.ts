import { BadRequestException } from '@nestjs/common'

/** Preserve the requested GiB; Runner rounds up only when converting to MiB. */
export function assertMemoryAllocation(gib: number): void {
  const mib = gib * 1024
  if (!Number.isFinite(mib) || mib < 256 || mib > 2147483647) {
    throw new BadRequestException('memory must be between 256 and 2147483647 MiB; recreate smaller boxes')
  }
}
