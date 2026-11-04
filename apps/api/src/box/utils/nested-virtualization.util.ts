import { HttpException, HttpStatus } from '@nestjs/common'

export function assertNestedVirtualizationEnabled(enabled: boolean | undefined): void {
  if (enabled !== true) {
    throw new HttpException(
      { message: 'Nested virtualization is not enabled on this server', code: 'unsupported' },
      HttpStatus.BAD_REQUEST,
    )
  }
}

export function assertSavedNestedVirtualization(boxId: string, enabled: boolean | undefined): void {
  if (enabled !== true) {
    throw new HttpException(
      { message: `Box ${boxId} did not confirm saved nested virtualization`, code: 'invalid_state' },
      HttpStatus.CONFLICT,
    )
  }
}
