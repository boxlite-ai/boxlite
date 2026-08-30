// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const DEFAULT_HTTP_TIMEOUT_MS = 15_000
const DEFAULT_READBACK_TIMEOUT_MS = 15_000
const DEFAULT_MAX_ASSET_BYTES = 5 * 1024 * 1024
const STAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/
const PROMPT_PART_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject
export type JsonObject = { [key: string]: JsonValue }

export interface BrandingTarget {
  stage: string
  stackOrigin: string
  publicOidcIssuer: string
  auth0TenantDomain: string
}

export interface PromptText {
  prompt: string
  language: string
  text: JsonObject
}

export interface LoadedBranding {
  target: BrandingTarget
  theme: JsonObject
  prompts: PromptText[]
  assetUrls: string[]
  sourceDigest: string
}

interface ThemeChange {
  kind: 'theme'
  resource: 'theme'
  action: 'create' | 'update'
  themeId?: string
  before: JsonObject | null
  after: JsonObject
}

interface PromptChange {
  kind: 'prompt'
  resource: `prompt:${string}/${string}`
  prompt: string
  language: string
  before: JsonObject
  after: JsonObject
}

export type BrandingChange = ThemeChange | PromptChange

export interface PreparedBranding {
  target: BrandingTarget
  changes: BrandingChange[]
  checks: string[]
  sourceDigest: string
  remoteDigest: string
}

export interface ApplyReport {
  applied: string[]
}

export interface BrandingSource {
  load(stage: string): Promise<LoadedBranding>
}

export interface BrandingVerifier {
  verify(target: BrandingTarget, assetUrls: string[], signal?: AbortSignal): Promise<string[]>
}

export interface Auth0BrandingGateway {
  getDefaultTheme(target: BrandingTarget, signal?: AbortSignal): Promise<JsonObject | null>
  createTheme(target: BrandingTarget, theme: JsonObject, signal?: AbortSignal): Promise<void>
  updateTheme(target: BrandingTarget, themeId: string, theme: JsonObject, signal?: AbortSignal): Promise<void>
  getPromptText(target: BrandingTarget, prompt: string, language: string, signal?: AbortSignal): Promise<JsonObject>
  putPromptText(
    target: BrandingTarget,
    prompt: string,
    language: string,
    text: JsonObject,
    signal?: AbortSignal,
  ): Promise<void>
}

interface UniversalLoginBrandingDependencies {
  source: BrandingSource
  verifier: BrandingVerifier
  gateway: Auth0BrandingGateway
  readbackTimeoutMs?: number
}

interface RemoteBranding {
  theme: JsonObject | null
  prompts: Map<string, JsonObject>
}

export class PartialApplyError extends Error {
  readonly applied: string[]
  readonly unknown: string[]
  readonly pending: string[]

  constructor(
    message: string,
    { applied, unknown, pending, cause }: { applied: string[]; unknown: string[]; pending: string[]; cause?: unknown },
  ) {
    super(message, { cause })
    this.name = 'PartialApplyError'
    this.applied = applied
    this.unknown = unknown
    this.pending = pending
  }
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function withoutComments(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(withoutComments)
  if (!isObject(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.startsWith('_'))
      .map(([key, nested]) => [key, withoutComments(nested)]),
  )
}

function canonicalJson(value: JsonValue | undefined): string {
  if (value === undefined) return '{"$boxlite":"missing"}'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (!isObject(value)) return JSON.stringify(value)
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`
}

function digest(parts: readonly string[]) {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part).update('\0')
  return hash.digest('hex')
}

function parseJsonObject(contents: string, path: string): JsonObject {
  let value: unknown
  try {
    value = JSON.parse(contents)
  } catch (cause) {
    throw new Error(`${path} is not valid JSON`, { cause })
  }
  if (!isObject(value)) throw new Error(`${path} must contain a JSON object`)
  return value
}

function requireHttpsOrigin(name: string, value: unknown) {
  if (typeof value !== 'string') throw new Error(`${name} must be an HTTPS origin`)
  let url: URL
  try {
    url = new URL(value)
  } catch (cause) {
    throw new Error(`${name} must be an HTTPS origin`, { cause })
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== value ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an HTTPS origin without credentials, path, query, or fragment`)
  }
  return url.origin
}

function requireIssuer(value: unknown) {
  if (typeof value !== 'string') throw new Error('publicOidcIssuer must be an HTTPS URL ending in /')
  let url: URL
  try {
    url = new URL(value)
  } catch (cause) {
    throw new Error('publicOidcIssuer must be an HTTPS URL ending in /', { cause })
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !value.endsWith('/')) {
    throw new Error('publicOidcIssuer must be an HTTPS URL ending in /')
  }
  return value
}

function requireTenantDomain(value: unknown) {
  if (typeof value !== 'string' || !value.endsWith('.auth0.com') || value.includes('/')) {
    throw new Error('auth0TenantDomain must be a canonical Auth0 tenant hostname')
  }
  let url: URL
  try {
    url = new URL(`https://${value}`)
  } catch (cause) {
    throw new Error('auth0TenantDomain must be a canonical Auth0 tenant hostname', { cause })
  }
  if (url.hostname !== value.toLowerCase() || url.port || url.pathname !== '/') {
    throw new Error('auth0TenantDomain must be a canonical Auth0 tenant hostname')
  }
  return url.hostname
}

function parseTarget(catalog: JsonObject, stage: string): BrandingTarget {
  if (!STAGE_PATTERN.test(stage)) throw new Error(`stage '${stage}' must match ${STAGE_PATTERN}`)
  const raw = catalog[stage]
  if (!isObject(raw)) throw new Error(`stage '${stage}' is not configured in auth0/targets.json`)
  const knownKeys = new Set(['stackOrigin', 'publicOidcIssuer', 'auth0TenantDomain'])
  const unknownKeys = Object.keys(raw).filter((key) => !knownKeys.has(key))
  if (unknownKeys.length > 0) throw new Error(`stage '${stage}' has unknown target keys: ${unknownKeys.join(', ')}`)
  return {
    stage,
    stackOrigin: requireHttpsOrigin(`${stage}.stackOrigin`, raw.stackOrigin),
    publicOidcIssuer: requireIssuer(raw.publicOidcIssuer),
    auth0TenantDomain: requireTenantDomain(raw.auth0TenantDomain),
  }
}

function requireRelativeAsset(name: string, value: JsonValue | undefined, stackOrigin: string) {
  if (typeof value !== 'string' || !value.startsWith('/auth0/') || value.startsWith('//')) {
    throw new Error(`${name} must be a stage-relative /auth0/* path`)
  }
  const url = new URL(value, stackOrigin)
  if (url.origin !== stackOrigin) throw new Error(`${name} must stay on ${stackOrigin}`)
  return url.href
}

function prepareTheme(raw: JsonObject, target: BrandingTarget) {
  const theme = withoutComments(raw) as JsonObject
  if (!isObject(theme.colors) || !isObject(theme.fonts) || !isObject(theme.widget)) {
    throw new Error('branding/theme.json needs colors, fonts, and widget objects')
  }
  const fonts = theme.fonts
  const widget = theme.widget
  theme.widget = { ...widget, logo_url: requireRelativeAsset('widget.logo_url', widget.logo_url, target.stackOrigin) }
  if (fonts.font_url !== undefined) {
    theme.fonts = {
      ...fonts,
      font_url: requireRelativeAsset('fonts.font_url', fonts.font_url, target.stackOrigin),
    }
  }
  return theme
}

function validatePromptText(prompt: string, text: JsonObject) {
  if (Object.keys(text).length === 0) throw new Error(`the ${prompt} prompt document is empty`)
  for (const [screen, screenText] of Object.entries(text)) {
    if (!screen.trim() || !isObject(screenText) || Object.keys(screenText).length === 0) {
      throw new Error(`the ${prompt} prompt has an invalid '${screen}' screen`)
    }
    for (const [key, value] of Object.entries(screenText)) {
      if (!key.trim() || typeof value !== 'string' || !value.trim()) {
        throw new Error(`the ${prompt} prompt has invalid text '${screen}.${key}'`)
      }
    }
  }
}

export class FileBrandingSource implements BrandingSource {
  constructor(private readonly root = import.meta.dirname) {}

  async load(stage: string): Promise<LoadedBranding> {
    const targetsPath = join(this.root, 'targets.json')
    const themePath = join(this.root, 'branding', 'theme.json')
    const promptsRoot = join(this.root, 'branding', 'prompts')
    const targetsContents = await readFile(targetsPath, 'utf8')
    const themeContents = await readFile(themePath, 'utf8')
    const target = parseTarget(parseJsonObject(targetsContents, targetsPath), stage)
    const theme = prepareTheme(parseJsonObject(themeContents, themePath), target)
    const sourceParts = [`targets.json:${targetsContents}`, `branding/theme.json:${themeContents}`]
    const prompts: PromptText[] = []

    const languageEntries = (await readdir(promptsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))
    for (const languageEntry of languageEntries) {
      const language = languageEntry.name
      if (!PROMPT_PART_PATTERN.test(language)) throw new Error(`invalid prompt language directory '${language}'`)
      const languageRoot = join(promptsRoot, language)
      const promptEntries = (await readdir(languageRoot, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .sort((left, right) => left.name.localeCompare(right.name))
      for (const promptEntry of promptEntries) {
        const prompt = promptEntry.name.slice(0, -'.json'.length)
        if (!PROMPT_PART_PATTERN.test(prompt)) throw new Error(`invalid prompt filename '${promptEntry.name}'`)
        const promptPath = join(languageRoot, promptEntry.name)
        const contents = await readFile(promptPath, 'utf8')
        const text = withoutComments(parseJsonObject(contents, promptPath)) as JsonObject
        validatePromptText(`${prompt}/${language}`, text)
        prompts.push({ prompt, language, text })
        sourceParts.push(`branding/prompts/${language}/${promptEntry.name}:${contents}`)
      }
    }
    if (prompts.length === 0) throw new Error(`${promptsRoot} contains no prompt documents`)

    const resolvedWidget = theme.widget as JsonObject
    const resolvedFonts = theme.fonts as JsonObject
    const assetUrls = [resolvedWidget.logo_url, resolvedFonts.font_url].filter(
      (value): value is string => typeof value === 'string',
    )
    return { target, theme, prompts, assetUrls: [...new Set(assetUrls)], sourceDigest: digest(sourceParts) }
  }
}

async function readBoundedBody(response: Response, url: string, maxBytes: number) {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel()
    throw new Error(`the Universal Login asset ${url} exceeds the ${maxBytes}-byte download limit`)
  }
  if (!response.body) return 0
  const reader = response.body.getReader()
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) {
        await reader.cancel()
        throw new Error(`the Universal Login asset ${url} exceeds the ${maxBytes}-byte download limit`)
      }
    }
  } finally {
    reader.releaseLock()
  }
  return length
}

const ASSET_CONTENT_TYPES: Record<string, string> = { '.png': 'image/png', '.woff2': 'font/woff2' }

function expectedAssetContentType(url: string) {
  const pathname = new URL(url).pathname.toLowerCase()
  const extension = Object.keys(ASSET_CONTENT_TYPES).find((candidate) => pathname.endsWith(candidate))
  if (!extension) throw new Error(`the Universal Login asset ${url} has an unsupported file extension`)
  return ASSET_CONTENT_TYPES[extension]
}

interface HttpBrandingVerifierOptions {
  fetch?: typeof fetch
  timeoutMs?: number
  maxAssetBytes?: number
}

export class HttpBrandingVerifier implements BrandingVerifier {
  private readonly fetch: typeof fetch
  private readonly timeoutMs: number
  private readonly maxAssetBytes: number

  constructor({
    fetch: fetchImplementation = fetch,
    timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
    maxAssetBytes = DEFAULT_MAX_ASSET_BYTES,
  }: HttpBrandingVerifierOptions = {}) {
    this.fetch = fetchImplementation
    this.timeoutMs = timeoutMs
    this.maxAssetBytes = maxAssetBytes
  }

  async verify(target: BrandingTarget, assetUrls: string[], signal?: AbortSignal) {
    const checks = await this.verifyStackIdentity(target, signal)
    for (const url of assetUrls) {
      await this.verifyAsset(target, url, signal)
      checks.push(`asset ${url}`)
    }
    return checks
  }

  private requestSignal(signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    return signal ? AbortSignal.any([signal, timeout]) : timeout
  }

  private async verifyStackIdentity(target: BrandingTarget, signal?: AbortSignal) {
    const stack = new URL(target.stackOrigin)
    const configUrl = `https://api.${stack.hostname}/api/config`
    let response: Response
    try {
      response = await this.fetch(configUrl, { method: 'GET', redirect: 'error', signal: this.requestSignal(signal) })
    } catch (cause) {
      throw new Error(`could not read the ${target.stage} public configuration from ${configUrl}`, { cause })
    }
    if (response.status !== 200) {
      await response.body?.cancel()
      throw new Error(`${configUrl} returned ${response.status}`)
    }
    let configuration: unknown
    try {
      configuration = await response.json()
    } catch (cause) {
      throw new Error(`${configUrl} did not return valid JSON`, { cause })
    }
    if (!isObject(configuration)) throw new Error(`${configUrl} did not return a JSON object`)
    if (configuration.dashboardUrl !== target.stackOrigin) {
      throw new Error(
        `${configUrl} identifies dashboard '${String(configuration.dashboardUrl)}', expected '${target.stackOrigin}'`,
      )
    }
    if (!isObject(configuration.oidc) || configuration.oidc.issuer !== target.publicOidcIssuer) {
      const actual = isObject(configuration.oidc) ? configuration.oidc.issuer : undefined
      throw new Error(`${configUrl} identifies OIDC issuer '${String(actual)}', expected '${target.publicOidcIssuer}'`)
    }
    return ['stack identity', 'OIDC issuer']
  }

  private async verifyAsset(target: BrandingTarget, url: string, signal?: AbortSignal) {
    let response: Response
    try {
      response = await this.fetch(url, {
        method: 'GET',
        redirect: 'error',
        headers: { Origin: new URL(target.publicOidcIssuer).origin },
        signal: this.requestSignal(signal),
      })
    } catch (cause) {
      throw new Error(`could not reach the Universal Login asset ${url}`, { cause })
    }
    try {
      if (response.status !== 200) throw new Error(`the Universal Login asset ${url} returned ${response.status}`)
      const expectedContentType = expectedAssetContentType(url)
      const contentType = response.headers.get('content-type')
      const mediaType = contentType?.split(';', 1)[0].trim().toLowerCase()
      if (mediaType !== expectedContentType) {
        throw new Error(
          `the Universal Login asset ${url} returned Content-Type '${contentType ?? '<missing>'}', expected '${expectedContentType}'`,
        )
      }
      const allowOrigin = response.headers.get('access-control-allow-origin')
      const auth0Origin = new URL(target.publicOidcIssuer).origin
      if (allowOrigin !== '*' && allowOrigin !== auth0Origin) {
        throw new Error(
          `the Universal Login asset ${url} returned Access-Control-Allow-Origin '${allowOrigin ?? '<missing>'}', expected '*' or '${auth0Origin}'`,
        )
      }
    } catch (cause) {
      await response.body?.cancel()
      throw cause
    }
    const bodyLength = await readBoundedBody(response, url, this.maxAssetBytes)
    if (bodyLength === 0) throw new Error(`the Universal Login asset ${url} returned an empty body`)
  }
}

function projectManaged(remote: JsonObject | null, desired: JsonObject): JsonObject | null {
  if (remote === null) return null
  return Object.fromEntries(
    Object.entries(desired).map(([key, desiredValue]) => {
      const remoteValue = remote[key]
      if (isObject(desiredValue) && isObject(remoteValue)) return [key, projectManaged(remoteValue, desiredValue)]
      return [key, remoteValue]
    }),
  )
}

function promptKey(prompt: string, language: string) {
  return `${prompt}/${language}`
}

function promptResource(prompt: string, language: string): `prompt:${string}/${string}` {
  return `prompt:${prompt}/${language}`
}

function themeId(theme: JsonObject | null) {
  const id = theme?.themeId
  if (id === undefined) return undefined
  if (typeof id !== 'string' || !id.trim()) throw new Error('Auth0 returned a default theme without a themeId')
  return id
}

async function readRemote(gateway: Auth0BrandingGateway, desired: LoadedBranding, signal?: AbortSignal) {
  const theme = await gateway.getDefaultTheme(desired.target, signal)
  themeId(theme)
  const prompts = new Map<string, JsonObject>()
  for (const prompt of desired.prompts) {
    prompts.set(
      promptKey(prompt.prompt, prompt.language),
      await gateway.getPromptText(desired.target, prompt.prompt, prompt.language, signal),
    )
  }
  return { theme, prompts }
}

function remoteDigest(remote: RemoteBranding, desired: LoadedBranding) {
  const promptState = Object.fromEntries(
    desired.prompts.map(({ prompt, language }) => [
      promptKey(prompt, language),
      remote.prompts.get(promptKey(prompt, language)) ?? {},
    ]),
  ) as JsonObject
  return digest([
    canonicalJson({ themeId: themeId(remote.theme) ?? null, managed: projectManaged(remote.theme, desired.theme) }),
    canonicalJson(promptState),
  ])
}

function changesFor(remote: RemoteBranding, desired: LoadedBranding): BrandingChange[] {
  const changes: BrandingChange[] = []
  const managedTheme = projectManaged(remote.theme, desired.theme)
  if (remote.theme === null || !isDeepStrictEqual(managedTheme, desired.theme)) {
    const id = themeId(remote.theme)
    changes.push({
      kind: 'theme',
      resource: 'theme',
      action: id ? 'update' : 'create',
      themeId: id,
      before: managedTheme,
      after: desired.theme,
    })
  }
  for (const prompt of desired.prompts) {
    const before = remote.prompts.get(promptKey(prompt.prompt, prompt.language)) ?? {}
    if (!isDeepStrictEqual(before, prompt.text)) {
      changes.push({
        kind: 'prompt',
        resource: promptResource(prompt.prompt, prompt.language),
        prompt: prompt.prompt,
        language: prompt.language,
        before,
        after: prompt.text,
      })
    }
  }
  return changes
}

export class UniversalLoginBranding {
  private readonly source: BrandingSource
  private readonly verifier: BrandingVerifier
  private readonly gateway: Auth0BrandingGateway
  private readonly readbackTimeoutMs: number

  constructor({
    source,
    verifier,
    gateway,
    readbackTimeoutMs = DEFAULT_READBACK_TIMEOUT_MS,
  }: UniversalLoginBrandingDependencies) {
    this.source = source
    this.verifier = verifier
    this.gateway = gateway
    this.readbackTimeoutMs = readbackTimeoutMs
  }

  async prepare(stage: string, signal?: AbortSignal): Promise<PreparedBranding> {
    const desired = await this.source.load(stage)
    const checks = await this.verifier.verify(desired.target, desired.assetUrls, signal)
    const remote = await readRemote(this.gateway, desired, signal)
    return {
      target: desired.target,
      checks,
      changes: changesFor(remote, desired),
      sourceDigest: desired.sourceDigest,
      remoteDigest: remoteDigest(remote, desired),
    }
  }

  async apply(prepared: PreparedBranding, signal?: AbortSignal): Promise<ApplyReport> {
    const current = await this.prepare(prepared.target.stage, signal)
    if (current.sourceDigest !== prepared.sourceDigest) {
      throw new Error('local branding files changed since preview; preview again before applying')
    }
    if (current.remoteDigest !== prepared.remoteDigest) {
      throw new Error('Auth0 state changed since preview; preview again before applying')
    }

    const applied: string[] = []
    for (let index = 0; index < current.changes.length; index += 1) {
      const change = current.changes[index]
      const later = current.changes.slice(index + 1).map(({ resource }) => resource)
      if (signal?.aborted) {
        throw new PartialApplyError('Universal Login apply was interrupted before the next write', {
          applied,
          unknown: [],
          pending: [change.resource, ...later],
          cause: signal.reason,
        })
      }

      try {
        await this.writeChange(current.target, change, signal)
      } catch (cause) {
        const classification = await this.classifyAfterFailedWrite(current.target, change)
        if (classification === 'applied') applied.push(change.resource)
        throw new PartialApplyError(`Universal Login apply stopped while writing ${change.resource}`, {
          applied,
          unknown: classification === 'unknown' ? [change.resource] : [],
          pending: classification === 'pending' ? [change.resource, ...later] : later,
          cause,
        })
      }

      const readback = await this.readChange(current.target, change, AbortSignal.timeout(this.readbackTimeoutMs)).catch(
        (cause) => {
          throw new PartialApplyError(`could not verify ${change.resource} after Auth0 accepted the write`, {
            applied,
            unknown: [change.resource],
            pending: later,
            cause,
          })
        },
      )
      if (!this.matches(change, readback)) {
        throw new PartialApplyError(`Auth0 readback for ${change.resource} did not match the desired state`, {
          applied,
          unknown: [change.resource],
          pending: later,
        })
      }
      applied.push(change.resource)
    }
    return { applied }
  }

  private async writeChange(target: BrandingTarget, change: BrandingChange, signal?: AbortSignal) {
    if (change.kind === 'prompt') {
      await this.gateway.putPromptText(target, change.prompt, change.language, change.after, signal)
      return
    }
    if (change.action === 'create') {
      await this.gateway.createTheme(target, change.after, signal)
      return
    }
    if (!change.themeId) throw new Error('an existing theme update needs a themeId')
    await this.gateway.updateTheme(target, change.themeId, change.after, signal)
  }

  private async readChange(target: BrandingTarget, change: BrandingChange, signal?: AbortSignal) {
    return change.kind === 'theme'
      ? this.gateway.getDefaultTheme(target, signal)
      : this.gateway.getPromptText(target, change.prompt, change.language, signal)
  }

  private matches(change: BrandingChange, readback: JsonObject | null) {
    if (change.kind === 'theme')
      return readback !== null && isDeepStrictEqual(projectManaged(readback, change.after), change.after)
    return readback !== null && isDeepStrictEqual(readback, change.after)
  }

  private matchesBefore(change: BrandingChange, readback: JsonObject | null) {
    if (change.kind === 'theme') {
      return (
        (change.before === null && readback === null) ||
        (change.before !== null &&
          readback !== null &&
          isDeepStrictEqual(projectManaged(readback, change.after), change.before))
      )
    }
    return readback !== null && isDeepStrictEqual(readback, change.before)
  }

  private async classifyAfterFailedWrite(target: BrandingTarget, change: BrandingChange) {
    try {
      const readback = await this.readChange(target, change, AbortSignal.timeout(this.readbackTimeoutMs))
      if (this.matches(change, readback)) return 'applied'
      return this.matchesBefore(change, readback) ? 'pending' : 'unknown'
    } catch {
      return 'unknown'
    }
  }
}
