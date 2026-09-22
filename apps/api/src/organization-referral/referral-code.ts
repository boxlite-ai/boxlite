import { HttpException, HttpStatus } from '@nestjs/common'

export const REFERRAL_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const REFERRAL_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/
export const REFERRAL_UNIQUE_CONSTRAINT = 'organization_referral_code_uq'

export class RegistrationException extends HttpException {
  constructor(status: HttpStatus, code: string) {
    super({ statusCode: status, code, message: code }, status)
  }
}

/** Only the organizations-list guard opts a server request into this parser. */
export function normalizeReferralCode(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new RegistrationException(400, 'invalid_referral_code')
  const code = value.trim().toUpperCase()
  if (!code) return undefined
  if (!REFERRAL_PATTERN.test(code)) throw new RegistrationException(400, 'invalid_referral_code')
  return code
}

export function isLockTimeout(error: unknown): boolean {
  const failure = error as { code?: string; driverError?: { code?: string } }
  return (failure?.driverError?.code ?? failure?.code) === '55P03'
}

export function normalizeReferralQuery(query: Record<string, unknown>): string | undefined {
  if (Object.keys(query).some((key) => key.startsWith('referredCode['))) {
    throw new RegistrationException(400, 'invalid_referral_code')
  }
  return normalizeReferralCode(query.referredCode)
}
