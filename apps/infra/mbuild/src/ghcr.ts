import { createHash } from 'node:crypto'
import { addressFor, type Registry } from './address.ts'
import type { BuildConfig } from './config.ts'
import type { Registrar, Run } from './publish.ts'

const MANIFEST_TYPES = ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json']
// Request indexes too, so an unsupported existing release cannot look absent.
const ACCEPT_TYPES = [...MANIFEST_TYPES, 'application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json']

/** Bounded registry reads share the command boundary used by the cloud adapters. */
export const ghcrRegistrar = ({ config, registry, run, environment = process.env }: {
  config: BuildConfig
  registry: Extract<Registry, { kind: 'ghcr' }>
  run: Run
  environment?: NodeJS.ProcessEnv
}): Registrar => {
  const username = environment.GHCR_USERNAME ?? environment.GITHUB_ACTOR
  const password = environment.GHCR_TOKEN ?? environment.GH_TOKEN
  if (!username || !password) throw new Error('GHCR requires GHCR_USERNAME/GITHUB_ACTOR and GHCR_TOKEN/GH_TOKEN')
  const basic = Buffer.from(`${username}:${password}`).toString('base64')
  const parseResponse = (body: string, address: string): Record<string, unknown> => {
    try {
      const parsed = JSON.parse(body)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch { /* Do not include registry response bodies, which may contain credentials. */ }
    throw new Error(`Invalid GHCR JSON response for ${address}`)
  }
  const request = async (url: string, authorization: string, accept = 'application/json') => {
    const result = await run('curl', [
      '--disable', '--config', '-', '--silent', '--show-error', '--connect-timeout', '5', '--max-time', '30',
      '--max-filesize', '2097152', '--write-out', '\n%{http_code}\n%{content_type}', url,
    ], { stdin: `header = "Authorization: ${authorization}"\nheader = "Accept: ${accept}"\n` })
    if (result.code !== 0) throw new Error(`Could not query ${url}: curl exited ${result.code}`)
    const typeSeparator = result.stdout.lastIndexOf('\n')
    const separator = result.stdout.lastIndexOf('\n', typeSeparator - 1)
    const status = Number(result.stdout.slice(separator + 1, typeSeparator))
    if (separator < 0 || !Number.isInteger(status) || status < 100 || status > 599) throw new Error(`Invalid HTTP response from ${url}`)
    return { status, body: result.stdout.slice(0, separator), contentType: result.stdout.slice(typeSeparator + 1).split(';')[0]!.trim().toLowerCase() }
  }
  const digestOf = async (artifact: string, tag: string): Promise<string | null> => {
    const address = addressFor({ config, registry, artifact, tag })
    const name = `${registry.repository}/${artifact}`
    const token = await request(`https://ghcr.io/token?service=ghcr.io&scope=repository:${name}:pull`, `Basic ${basic}`)
    if (token.status !== 200) throw new Error(`Could not authenticate GHCR read of ${address}: HTTP ${token.status}`)
    const bearer = parseResponse(token.body, address).token
    if (typeof bearer !== 'string' || bearer.trim() !== bearer || !/^[A-Za-z0-9._=-]+$/.test(bearer)) throw new Error('GHCR returned an invalid bearer token')
    const manifest = await request(`https://ghcr.io/v2/${name}/manifests/${tag}`, `Bearer ${bearer}`, ACCEPT_TYPES.join(', '))
    if (manifest.status === 404) {
      const errors = parseResponse(manifest.body, address).errors
      if (Array.isArray(errors) && errors.length > 0 && errors.every((error) => ['MANIFEST_UNKNOWN', 'NAME_UNKNOWN'].includes(error.code))) return null
    }
    if (manifest.status !== 200) throw new Error(`Could not read GHCR manifest ${address}: HTTP ${manifest.status}`)
    const parsed = parseResponse(manifest.body, address)
    if (parsed.schemaVersion !== 2 || !MANIFEST_TYPES.includes(manifest.contentType) ||
      (parsed.mediaType !== undefined && parsed.mediaType !== manifest.contentType)) {
      throw new Error(`GHCR release ${address} must be a single-platform OCI or Docker schema 2 manifest`)
    }
    return `sha256:${createHash('sha256').update(manifest.body).digest('hex')}`
  }
  return {
    ensureRepository: async () => {}, // GHCR creates repository-linked packages on first push.
    digestOf,
    isPublished: async (artifact, tag) => (await digestOf(artifact, tag)) !== null,
    async login() {
      const result = await run('docker', ['login', '--username', username, '--password-stdin', 'ghcr.io'], { stdin: password })
      if (result.code !== 0) throw new Error(`Could not log in to GHCR: docker exited ${result.code}`)
    },
    async scanReport() { throw new Error('GHCR images are scanned after import into the deployment stage') },
  }
}
