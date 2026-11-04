import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse } from 'dotenv'
import { NestFactory } from '@nestjs/core'

// Use the public example in an isolated directory, never a developer's environment or .env.
process.env = {
  PATH: process.env.PATH,
  ...parse(readFileSync(resolve(process.argv[2] || 'api/.env.example'))),
  NODE_ENV: 'production',
  APP_MODE: 'api',
  SKIP_CONNECTIONS: 'true',
  DISABLE_CRON_JOBS: 'true',
  OTEL_ENABLED: 'false',
  CLOUD_APP_PUBLIC_URL: 'https://api.example.test/api/internal/apps',
  CLOUD_APP_SOURCE_BUCKET: 'bootstrap-test',
  CLOUD_APP_SESSION_SECRET: 'bootstrap-test-session',
  CLOUD_APP_IDENTITY_PRIVATE_KEY: generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString(),
}
const directory = mkdtempSync(join(tmpdir(), 'boxlite-api-bootstrap-'))
process.chdir(directory)
const timeout = setTimeout(() => {
  console.error('API bootstrap check timed out')
  process.exit(1)
}, 30_000)
process.on('exit', () => {
  clearTimeout(timeout)
  rmSync(directory, { recursive: true, force: true })
})

async function check() {
  if (process.argv.includes('--openapi')) {
    await import('./generate-openapi.js')
    return
  }
  const { AppModule } = await import('./app.module.js')
  const { AppService } = await import('./app.service.js')
  const { OrganizationService } = await import('./organization/services/organization.service.js')
  const { NotificationGateway } = await import('./notification/gateways/notification.gateway.js')
  const app = await NestFactory.create(AppModule, { logger: ['error'], abortOnError: false })
  try {
    // These existing hooks seed PostgreSQL or subscribe to Redis despite SKIP_CONNECTIONS.
    app.get(AppService).onApplicationBootstrap = async () => {}
    app.get(OrganizationService).onModuleInit = async () => {}
    app.get(NotificationGateway).onModuleInit = () => {}
    app.setGlobalPrefix('api')
    await app.init()
    const routes = app
      .getHttpAdapter()
      .getInstance()
      .router.stack.flatMap((layer: { route?: { path: string | string[] } }) => layer.route?.path ?? []) as string[]
    for (const path of [
      '/api/v1/:organizationId/apps',
      '/api/v1/:organizationId/apps/{*path}',
      '/api/internal/apps/ingress/:environmentId/{*path}',
      '/api/internal/apps/sv/v1/{*path}',
      '/api/internal/apps/artifacts/:version/:file',
    ])
      assert(routes.includes(path), `Missing App route: ${path}`)
    const { classify } = await import('./cloud-app/engine/sqlguard.js')
    assert.equal(classify('SELECT 1').refused, null)
    console.log('API bootstrap, App routes and PostgreSQL parser ready')
  } finally {
    await app.close()
  }
}

check()
  .then(() => {
    if (!process.argv.includes('--openapi')) process.exit(0)
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
