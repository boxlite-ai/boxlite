/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

export const DEFAULT_QUICKSTART_API_KEY_NAME = 'sdk-quickstart'

export function resolveQuickstartApiKeyBaseName(value: string): string {
  const trimmed = value.trim()
  return trimmed === '' ? DEFAULT_QUICKSTART_API_KEY_NAME : trimmed
}

export function buildQuickstartApiKeyName(attempt = 0, baseName = DEFAULT_QUICKSTART_API_KEY_NAME): string {
  return attempt <= 0 ? baseName : `${baseName}-${randomUuidSuffix()}`
}

function randomUuidSuffix(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 4)
  }

  return Math.random().toString(36).slice(2, 6).padEnd(4, '0')
}

export function isApiKeyNameConflict(error: unknown): boolean {
  const err = error as { cause?: { response?: { status?: number } }; response?: { status?: number }; message?: string }
  const status = err?.cause?.response?.status ?? err?.response?.status
  if (status === 409) return true
  return typeof err?.message === 'string' && err.message.includes('already exists')
}

export async function createApiKeyWithFallbackName<T>(
  create: (name: string) => Promise<T>,
  options: { baseName?: string; maxAttempts?: number } = {},
): Promise<T> {
  const baseName = resolveQuickstartApiKeyBaseName(options.baseName ?? '')
  const maxAttempts = options.maxAttempts ?? 5
  let lastError: unknown

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await create(buildQuickstartApiKeyName(attempt, baseName))
    } catch (error) {
      if (!isApiKeyNameConflict(error)) throw error
      lastError = error
    }
  }

  throw lastError
}
