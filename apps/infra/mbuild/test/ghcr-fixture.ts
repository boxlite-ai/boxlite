import { createHash } from 'node:crypto'
import { ghcrRegistryFor } from '../src/address.ts'
import { parseBuildConfig } from '../src/config.ts'

export const sha = 'a'.repeat(40)
export const tag = `v1.2.3-${sha}`
export const ghcr = ghcrRegistryFor('BoxLite-AI/BoxLite')
export const manifest = JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
  config: { mediaType: 'application/vnd.docker.container.image.v1+json', digest: `sha256:${'b'.repeat(64)}`, size: 2 }, layers: [] })
export const digest = `sha256:${createHash('sha256').update(manifest).digest('hex')}`
export const credentials = { GHCR_USERNAME: 'actor', GHCR_TOKEN: 'test-secret' }
export const config = parseBuildConfig({
  basePath: '/repo/apps/infra/mstage.env.json',
  base: JSON.stringify({ root: '../..', artifacts: { api: { dockerfile: 'apps/api/Dockerfile', context: '.' }, proxy: { dockerfile: 'apps/proxy/Dockerfile', context: '.' } } }),
  stagePath: '/repo/apps/infra/.mstage.config.json',
  stages: JSON.stringify({ stages: {
    dev: { home: 'gcp', project: 'project', region: 'us-east1', registry: { kind: 'artifact-registry', repository: 'images', immutableTags: true, scanOnPush: true }, scan: { blockOn: ['HIGH'], timeoutSeconds: 1 } },
    prod: { home: 'aws', region: 'us-east-1', registry: { kind: 'ecr', repository: 'images-prod', immutableTags: true, scanOnPush: true }, scan: { blockOn: ['HIGH'], timeoutSeconds: 1 } },
  } }),
})
export const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' })
export const response = (body: unknown, status = 200, contentType = 'application/json') =>
  ok(`${typeof body === 'string' ? body : JSON.stringify(body)}\n${status}\n${contentType}`)
