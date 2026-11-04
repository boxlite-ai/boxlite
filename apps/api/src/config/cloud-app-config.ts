import { createPrivateKey } from 'node:crypto'

export function cloudAppConfig(env: NodeJS.ProcessEnv = process.env) {
  const publicUrl = env.CLOUD_APP_PUBLIC_URL?.replace(/\/+$/, '')
  const processRole = env.CLOUD_APP_PROCESS_ROLE || 'api'
  if (!['api', 'worker'].includes(processRole)) throw new Error('CLOUD_APP_PROCESS_ROLE must be api or worker')
  let oauth: Record<string, { clientId: string; clientSecret: string }>
  try {
    oauth = JSON.parse(env.CLOUD_APP_OAUTH_CLIENTS || '{}')
  } catch {
    throw new Error('CLOUD_APP_OAUTH_CLIENTS must be a JSON object')
  }
  if (!oauth || Array.isArray(oauth) || typeof oauth !== 'object')
    throw new Error('CLOUD_APP_OAUTH_CLIENTS must be a JSON object')
  for (const [provider, client] of Object.entries(oauth)) {
    if (!client?.clientId || !client?.clientSecret)
      throw new Error(`Incomplete App OAuth configuration for ${provider}`)
  }
  const privateKey = env.CLOUD_APP_IDENTITY_PRIVATE_KEY?.replace(/\\n/g, '\n')
  if (publicUrl) {
    const url = new URL(publicUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash || url.username || url.password) {
      throw new Error('CLOUD_APP_PUBLIC_URL must be an HTTP API base URL')
    }
    for (const key of ['CLOUD_APP_SESSION_SECRET', 'CLOUD_APP_IDENTITY_PRIVATE_KEY', 'CLOUD_APP_SOURCE_BUCKET']) {
      if (!env[key]) throw new Error(`${key} is required for Cloud Apps`)
    }
    if (createPrivateKey(privateKey).asymmetricKeyType !== 'rsa')
      throw new Error('CLOUD_APP_IDENTITY_PRIVATE_KEY must be an RSA private key for RS256')
  }
  const count = (name: string, fallback: number, minimum = 1) => {
    const value = env[name] === undefined ? fallback : Number(env[name])
    if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`)
    return value
  }
  return {
    publicUrl,
    processRole,
    domain: env.CLOUD_APP_DOMAIN || env.PROXY_APP_DOMAIN,
    sessionSecret: env.CLOUD_APP_SESSION_SECRET,
    identityPrivateKey: privateKey,
    oauth,
    artifactVersion: env.CLOUD_APP_ARTIFACT_VERSION || env.VERSION || 'dev',
    artifactUrl: env.CLOUD_APP_ARTIFACT_URL?.replace(/\/+$/, ''),
    sourceBackend: env.CLOUD_APP_SOURCE_BACKEND || env.VOLUME_STORAGE_BACKEND || 's3',
    sourceBucket: env.CLOUD_APP_SOURCE_BUCKET,
    sourcePrefix: env.CLOUD_APP_SOURCE_PREFIX || 'cloud-apps',
    buildTimeoutMs: count('CLOUD_APP_BUILD_TIMEOUT_SECONDS', 1800) * 1000,
    startupTimeoutMs: count('CLOUD_APP_STARTUP_TIMEOUT_SECONDS', 180) * 1000,
    diskSizeGb: count('CLOUD_APP_DISK_SIZE_GB', 10),
    autoStopSeconds: count('CLOUD_APP_AUTO_STOP_SECONDS', 900, 0),
    runtimeImages: {
      base: env.BOXLITE_SYSTEM_BASE_IMAGE || 'base',
      node: env.BOXLITE_SYSTEM_NODE_IMAGE || 'node',
      python: env.BOXLITE_SYSTEM_PYTHON_IMAGE || 'python',
    },
    neon: {
      apiUrl: env.NEON_API_URL || 'https://console.neon.tech/api/v2',
      apiKey: env.NEON_API_KEY,
      organizationId: env.NEON_ORG_ID,
      region: env.NEON_REGION,
      pgVersion: count('NEON_PG_VERSION', 17),
      database: env.NEON_DATABASE || 'neondb',
      role: env.NEON_ROLE || 'neondb_owner',
    },
  }
}
