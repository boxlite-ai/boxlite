import { generateKeyPairSync } from 'node:crypto'
import { cloudAppConfig } from './cloud-app-config'

describe('Cloud App deployment configuration', () => {
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString()
  const enabled = {
    CLOUD_APP_PUBLIC_URL: 'https://api.example/api/internal/apps/',
    CLOUD_APP_SOURCE_BUCKET: 'source-bucket',
    CLOUD_APP_SESSION_SECRET: 'test-session-secret',
    CLOUD_APP_IDENTITY_PRIVATE_KEY: privateKey,
  }

  it('requires durable source storage and injected identity material before enabling routes', () => {
    expect(() => cloudAppConfig({ CLOUD_APP_PUBLIC_URL: enabled.CLOUD_APP_PUBLIC_URL })).toThrow(
      'CLOUD_APP_SESSION_SECRET',
    )
    expect(() => cloudAppConfig({ ...enabled, CLOUD_APP_SOURCE_BUCKET: undefined })).toThrow('CLOUD_APP_SOURCE_BUCKET')
    expect(cloudAppConfig(enabled).publicUrl).toBe('https://api.example/api/internal/apps')
  })

  it('uses the official Neon API and injected platform image references', () => {
    const configured = cloudAppConfig({
      ...enabled,
      NEON_API_KEY: 'test-neon-key',
      BOXLITE_SYSTEM_NODE_IMAGE: 'node-stable',
      CLOUD_APP_PROCESS_ROLE: 'worker',
    })
    expect(configured.neon.apiUrl).toBe('https://console.neon.tech/api/v2')
    expect(configured.runtimeImages.node).toBe('node-stable')
    expect(configured.processRole).toBe('worker')
  })

  it('defaults guest callbacks to the public API and accepts a separate HTTP address for local Boxes', () => {
    const cloud = cloudAppConfig(enabled)
    expect(cloud.supervisorUrl).toBe(cloud.publicUrl)
    const guest = 'http://host.boxlite.internal:3001/api/internal/apps'
    const local = cloudAppConfig({ ...enabled, CLOUD_APP_SUPERVISOR_URL: guest + '/' })
    expect(local.supervisorUrl).toBe(guest)
    expect(local.publicUrl).toBe(cloud.publicUrl)
    expect(() => cloudAppConfig({ ...enabled, CLOUD_APP_SUPERVISOR_URL: guest + '?token=foo' })).toThrow(
      'CLOUD_APP_SUPERVISOR_URL',
    )
  })
})
