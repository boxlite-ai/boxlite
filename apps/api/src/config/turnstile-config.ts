/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

export function turnstileConfig(env: NodeJS.ProcessEnv = process.env) {
  const sitekey = env.TURNSTILE_SITEKEY?.trim()
  if (!sitekey) return undefined
  const required = (name: string): string => {
    const value = env[name]?.trim()
    if (!value) throw new Error(`${name} is required`)
    return value
  }
  const expectedHostnames = [
    ...new Set(
      required('TURNSTILE_EXPECTED_HOSTNAMES')
        .split(',')
        .map((host) => host.trim().toLowerCase()),
    ),
  ]
  if (expectedHostnames.some((host) => !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(host))) {
    throw new Error('TURNSTILE_EXPECTED_HOSTNAMES must contain hostnames without schemes, ports or paths')
  }
  const rawTimeout = env.TURNSTILE_TIMEOUT_MS
  const timeoutMs = rawTimeout === undefined ? 5000 : Number(rawTimeout)
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('TURNSTILE_TIMEOUT_MS must be a positive integer')
  }
  return {
    sitekey,
    secretKey: required('TURNSTILE_SECRET_KEY'),
    expectedHostnames,
    timeoutMs,
    action: 'signup' as const,
  }
}
