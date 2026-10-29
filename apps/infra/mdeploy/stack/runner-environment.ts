/** Additional Runner process settings; deployment-owned keys keep their existing channels. */
const RESERVED = new Set([
  'BOXLITE_RUNNER_ENV',
  'BOXLITE_RUNNER_TOKEN',
  'BOXLITE_RUNNER_NAME',
  'RUNNER_DOMAIN',
  'BOXLITE_API_URL',
  'API_VERSION',
  'API_PORT',
  'BOXLITE_HOME_DIR',
  'BOXLITE_KERNEL_PATH',
  'OTEL_LOGGING_ENABLED',
  'OTEL_TRACING_ENABLED',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'REGISTRY_PROXY_HOST',
  'VOLUME_STORAGE_BACKEND',
  'AWS_REGION',
  'CLOUDSDK_CORE_PROJECT',
])

export const RUNNER_ENV_BEGIN = '# BEGIN BOXLITE_RUNNER_ENV'
export const RUNNER_ENV_END = '# END BOXLITE_RUNNER_ENV'

/** One serializer for boot and convergence: systemd quoting, never shell expansion. */
export const renderRunnerEnvironment = (
  raw?: string,
  ownedNames: readonly string[] = [],
): { block: string; keys: string[] } => {
  let values: unknown
  try {
    values = JSON.parse(raw || '{}')
  } catch {
    throw new Error('BOXLITE_RUNNER_ENV must be a JSON object of strings')
  }
  if (!values || Array.isArray(values) || typeof values !== 'object') {
    throw new Error('BOXLITE_RUNNER_ENV must be a JSON object of strings')
  }
  const entries = Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || /[\0\r\n]/.test(value)) {
      throw new Error('BOXLITE_RUNNER_ENV requires valid environment names and single-line string values')
    }
    if (RESERVED.has(key) || ownedNames.includes(key)) {
      throw new Error(`BOXLITE_RUNNER_ENV cannot override deployment-owned key ${key}`)
    }
  }
  const lines = entries.map(
    ([key, value]) => `${key}="${(value as string).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`,
  )
  return {
    keys: entries.map(([key]) => key),
    block: lines.length ? [RUNNER_ENV_BEGIN, ...lines, RUNNER_ENV_END].join('\n') : '',
  }
}
