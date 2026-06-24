const RESERVED_ENV_VARS = new Set(['BOXLITE_EXECUTOR'])

export const RESERVED_ENV_MESSAGE = 'BOXLITE_EXECUTOR is reserved and cannot be set by user requests'

export function hasReservedEnv(env: unknown): boolean {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return false
  }
  return Object.keys(env).some((key) => RESERVED_ENV_VARS.has(key))
}

export function hasReservedEnvInBody(body: unknown): boolean {
  if (!body || typeof body !== 'object') {
    return false
  }
  return hasReservedEnv((body as { env?: unknown }).env)
}
