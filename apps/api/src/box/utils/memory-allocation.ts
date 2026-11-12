import { BadRequestException } from '@nestjs/common'

/** Cloud models use GiB; validate before narrowing through Runner's C ABI. */
export function assertMemoryAllocation(gib: number): void {
  const mib = gib * 1024
  if (!Number.isInteger(mib) || mib < 256 || mib > 2147483647) {
    throw new BadRequestException('memory must be an integer between 256 and 2147483647 MiB; recreate smaller boxes')
  }
}
