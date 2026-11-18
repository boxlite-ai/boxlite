import { ServiceUnavailableException } from '@nestjs/common'

export const AUDIT_WRITE_TIMEOUT_MS = 5000

/** Check the clock as well as the timer: a busy event loop can delay timer delivery. */
export function remainingAuditTime(deadline: number): number {
  const remaining = Math.ceil(deadline - performance.now())
  if (remaining <= 0) throw new ServiceUnavailableException('Audit write deadline exceeded')
  return remaining
}
