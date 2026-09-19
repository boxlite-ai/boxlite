export function businessEventsConfig(env: NodeJS.ProcessEnv = process.env) {
  if (env.BUSINESS_EVENTS_ENABLED !== undefined && !['true', 'false'].includes(env.BUSINESS_EVENTS_ENABLED)) {
    throw new Error('BUSINESS_EVENTS_ENABLED must be true or false')
  }
  const count = (name: string, fallback: number) => {
    const value = env[name] ?? String(fallback)
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
      throw new Error(name + ' must be a positive whole number')
    }
    return Number(value)
  }
  const settings = {
    enabled: env.BUSINESS_EVENTS_ENABLED !== 'false',
    url: env.USAGE_EXPORT_URL?.trim(),
    token: env.USAGE_EXPORT_TOKEN?.trim(),
    intervalMs: count('BUSINESS_EVENTS_INTERVAL_MS', 30_000),
    batchSize: count('BUSINESS_EVENTS_BATCH_SIZE', 20),
    concurrency: count('BUSINESS_EVENTS_CONCURRENCY', 4),
    timeoutMs: count('BUSINESS_EVENTS_TIMEOUT_MS', 10_000),
    visibilityMs: count('BUSINESS_EVENTS_VISIBILITY_MS', 120_000),
    maxAttempts: count('BUSINESS_EVENTS_MAX_ATTEMPTS', 10),
    maxBackoffMs: count('BUSINESS_EVENTS_MAX_BACKOFF_MS', 900_000),
  }
  if (Math.ceil(settings.batchSize / settings.concurrency) * settings.timeoutMs + 5_000 >= settings.visibilityMs) {
    throw new Error('BUSINESS_EVENTS_VISIBILITY_MS must exceed the whole batch timeout budget plus 5 seconds')
  }
  if (!settings.enabled) return settings
  if (!settings.url || !settings.token) {
    throw new Error('USAGE_EXPORT_URL and USAGE_EXPORT_TOKEN are required when BUSINESS_EVENTS_ENABLED is true')
  }
  let url: URL
  try {
    url = new URL(settings.url)
  } catch {
    throw new Error('USAGE_EXPORT_URL must be an absolute http(s) URL')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    settings.url.includes('?') ||
    settings.url.includes('#') ||
    /\/api\/billing\/?$/.test(url.pathname)
  ) {
    throw new Error(
      'USAGE_EXPORT_URL must be a Commerce service base URL without credentials, query, fragment or /api/billing',
    )
  }
  settings.url = settings.url.replace(/\/+$/, '')
  return settings
}

export type BusinessEventsConfig = ReturnType<typeof businessEventsConfig>
