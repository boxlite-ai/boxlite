import { HttpException, HttpStatus } from '@nestjs/common'

export const REFERRAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const REFERRAL_UNIQUE_CONSTRAINT = 'organization_referral_code_uq'

export class RegistrationException extends HttpException {
  constructor(status: HttpStatus, code: string) {
    super({ statusCode: status, code, message: code }, status)
  }
}

export function isLockTimeout(error: unknown): boolean {
  const failure = error as { code?: string; driverError?: { code?: string } }
  return (failure?.driverError?.code ?? failure?.code) === '55P03'
}
