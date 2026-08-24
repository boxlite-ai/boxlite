// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { Auth0ManagementCli } from './management-cli.js'
import { parseUniversalLoginArgs, runUniversalLoginCommand } from './universal-login-command.js'
import {
  FileBrandingSource,
  HttpBrandingVerifier,
  PartialApplyError,
  UniversalLoginBranding,
  type Auth0BrandingGateway,
  type BrandingTarget,
  type BrandingSource,
  type JsonObject,
  type LoadedBranding,
  type PromptText,
} from './universal-login.js'

const TARGET = {
  stage: 'dev',
  stackOrigin: 'https://dev.example.com',
  publicOidcIssuer: 'https://auth.dev.example.com/',
  auth0TenantDomain: 'tenant.us.auth0.com',
}

const THEME = {
  colors: { page_background: '#13161B' },
  fonts: { font_url: 'https://dev.example.com/auth0/font.woff2' },
  widget: { logo_url: 'https://dev.example.com/auth0/logo.png' },
} satisfies JsonObject

const PROMPTS: PromptText[] = [
  { prompt: 'login', language: 'en', text: { login: { title: 'Welcome back' } } },
  { prompt: 'signup', language: 'en', text: { signup: { title: 'Welcome to BoxLite' } } },
]

function loaded(sourceDigest = 'source-1'): LoadedBranding {
  return {
    target: TARGET,
    theme: THEME,
    prompts: PROMPTS,
    assetUrls: [THEME.widget.logo_url, THEME.fonts.font_url],
    sourceDigest,
  }
}

class MemorySource implements BrandingSource {
  current = loaded()

  async load(stage: string) {
    assert.equal(stage, 'dev')
    return structuredClone(this.current)
  }
}

class MemoryGateway implements Auth0BrandingGateway {
  theme: JsonObject | null = {
    themeId: 'thm_1',
    colors: { page_background: '#ffffff' },
    fonts: THEME.fonts,
    widget: THEME.widget,
  }
  prompts = new Map(PROMPTS.map(({ prompt, language }) => [`${prompt}/${language}`, {}]))
  events: string[] = []
  failPrompt: string | undefined
  partialPrompt: JsonObject | undefined

  async getDefaultTheme() {
    this.events.push('read:theme')
    return structuredClone(this.theme)
  }

  async createTheme(_target: BrandingTarget, theme: JsonObject) {
    this.events.push('write:theme:create')
    this.theme = { themeId: 'thm_new', ...structuredClone(theme) }
  }

  async updateTheme(_target: BrandingTarget, themeId: string, theme: JsonObject) {
    this.events.push(`write:theme:${themeId}`)
    this.theme = { themeId, ...structuredClone(theme) }
  }

  async getPromptText(_target: BrandingTarget, prompt: string, language: string) {
    this.events.push(`read:${prompt}/${language}`)
    return structuredClone(this.prompts.get(`${prompt}/${language}`) ?? {})
  }

  async putPromptText(_target: BrandingTarget, prompt: string, language: string, text: JsonObject) {
    this.events.push(`write:${prompt}/${language}`)
    if (this.failPrompt === prompt) {
      if (this.partialPrompt) this.prompts.set(`${prompt}/${language}`, structuredClone(this.partialPrompt))
      throw new Error(`failed ${prompt}`)
    }
    this.prompts.set(`${prompt}/${language}`, structuredClone(text))
  }
}

function service(source = new MemorySource(), gateway = new MemoryGateway()) {
  const verified: string[] = []
  const branding = new UniversalLoginBranding({
    source,
    gateway,
    verifier: {
      async verify(target, assetUrls) {
        verified.push(target.stage, ...assetUrls)
        return ['stack identity', 'OIDC issuer', ...assetUrls.map((url) => `asset ${url}`)]
      },
    },
  })
  return { branding, source, gateway, verified }
}

test('preview validates the target and returns deterministic typed changes without writing', async () => {
  const { branding, gateway, verified } = service()
  const prepared = await branding.prepare('dev')

  assert.deepEqual(
    prepared.changes.map((change) => change.resource),
    ['theme', 'prompt:login/en', 'prompt:signup/en'],
  )
  assert.deepEqual(gateway.events, ['read:theme', 'read:login/en', 'read:signup/en'])
  assert.deepEqual(verified, ['dev', THEME.widget.logo_url, THEME.fonts.font_url])
})

test('apply refuses changed local input before its first write', async () => {
  const { branding, source, gateway } = service()
  const prepared = await branding.prepare('dev')
  source.current.sourceDigest = 'source-2'
  gateway.events.length = 0

  await assert.rejects(() => branding.apply(prepared), /local branding files changed since preview/)
  assert.equal(
    gateway.events.some((event) => event.startsWith('write:')),
    false,
  )
})

test('apply refuses changed remote state before its first write', async () => {
  const { branding, gateway } = service()
  const prepared = await branding.prepare('dev')
  gateway.theme = { ...gateway.theme, colors: { page_background: '#000000' } }
  gateway.events.length = 0

  await assert.rejects(() => branding.apply(prepared), /Auth0 state changed since preview/)
  assert.equal(
    gateway.events.some((event) => event.startsWith('write:')),
    false,
  )
})

test('apply writes in deterministic order and reads every resource back', async () => {
  const { branding, gateway } = service()
  const prepared = await branding.prepare('dev')
  gateway.events.length = 0

  const report = await branding.apply(prepared)

  assert.deepEqual(report.applied, ['theme', 'prompt:login/en', 'prompt:signup/en'])
  assert.deepEqual(gateway.events.slice(-6), [
    'write:theme:thm_1',
    'read:theme',
    'write:login/en',
    'read:login/en',
    'write:signup/en',
    'read:signup/en',
  ])
})

test('a fresh tenant creates its theme before applying prompt text', async () => {
  const gateway = new MemoryGateway()
  gateway.theme = null
  const { branding } = service(new MemorySource(), gateway)
  const prepared = await branding.prepare('dev')
  assert.equal(prepared.changes[0].kind, 'theme')
  assert.equal(prepared.changes[0].kind === 'theme' && prepared.changes[0].action, 'create')

  gateway.events.length = 0
  await branding.apply(prepared)
  assert.equal(gateway.events.includes('write:theme:create'), true)
})

test('a failed write reports applied, unknown, and pending resources', async () => {
  const { branding, gateway } = service()
  const prepared = await branding.prepare('dev')
  gateway.failPrompt = 'login'

  await assert.rejects(
    () => branding.apply(prepared),
    (error: unknown) => {
      assert.ok(error instanceof PartialApplyError)
      assert.deepEqual(error.applied, ['theme'])
      assert.deepEqual(error.unknown, [])
      assert.deepEqual(error.pending, ['prompt:login/en', 'prompt:signup/en'])
      return true
    },
  )
})

test('a failed write with partially changed readback reports the resource as unknown', async () => {
  const { branding, gateway } = service()
  const prepared = await branding.prepare('dev')
  gateway.failPrompt = 'login'
  gateway.partialPrompt = { login: { title: 'partially applied' } }

  await assert.rejects(
    () => branding.apply(prepared),
    (error: unknown) => {
      assert.ok(error instanceof PartialApplyError)
      assert.deepEqual(error.applied, ['theme'])
      assert.deepEqual(error.unknown, ['prompt:login/en'])
      assert.deepEqual(error.pending, ['prompt:signup/en'])
      return true
    },
  )
})

test('an interrupt stops before the next write and reports the completed readback', async () => {
  const gateway = new MemoryGateway()
  const controller = new AbortController()
  const updateTheme = gateway.updateTheme.bind(gateway)
  gateway.updateTheme = async (...args) => {
    await updateTheme(...args)
    controller.abort(new Error('operator interrupted'))
  }
  const { branding } = service(new MemorySource(), gateway)
  const prepared = await branding.prepare('dev')

  await assert.rejects(
    () => branding.apply(prepared, controller.signal),
    (error: unknown) => {
      assert.ok(error instanceof PartialApplyError)
      assert.deepEqual(error.applied, ['theme'])
      assert.deepEqual(error.unknown, [])
      assert.deepEqual(error.pending, ['prompt:login/en', 'prompt:signup/en'])
      return true
    },
  )
})

test('the file source discovers one complete prompt document per language and prompt', async () => {
  const root = mkdtempSync(join(tmpdir(), 'boxlite-auth0-branding-'))
  try {
    mkdirSync(join(root, 'branding', 'prompts', 'en'), { recursive: true })
    writeFileSync(
      join(root, 'targets.json'),
      JSON.stringify({
        dev: {
          stackOrigin: TARGET.stackOrigin,
          publicOidcIssuer: TARGET.publicOidcIssuer,
          auth0TenantDomain: TARGET.auth0TenantDomain,
        },
      }),
    )
    writeFileSync(
      join(root, 'branding', 'theme.json'),
      JSON.stringify({ ...THEME, fonts: { font_url: '/auth0/font.woff2' }, widget: { logo_url: '/auth0/logo.png' } }),
    )
    writeFileSync(join(root, 'branding', 'prompts', 'en', 'login.json'), JSON.stringify(PROMPTS[0].text))
    writeFileSync(join(root, 'branding', 'prompts', 'en', 'signup.json'), JSON.stringify(PROMPTS[1].text))

    const source = new FileBrandingSource(root)
    const result = await source.load('dev')
    assert.deepEqual(result.prompts, PROMPTS)
    assert.deepEqual(result.assetUrls, [THEME.widget.logo_url, THEME.fonts.font_url])

    const firstDigest = result.sourceDigest
    writeFileSync(
      join(root, 'branding', 'prompts', 'en', 'login.json'),
      JSON.stringify({ login: { title: 'Changed after preview' } }),
    )
    assert.notEqual((await source.load('dev')).sourceDigest, firstDigest)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the checked-in source binds dev to the reviewed stack, issuer, tenant, and copy', async () => {
  const source = await new FileBrandingSource().load('dev')
  assert.deepEqual(source.target, {
    stage: 'dev',
    stackOrigin: 'https://dev.boxlite.ai',
    publicOidcIssuer: 'https://auth.dev.boxlite.ai/',
    auth0TenantDomain: 'dev-j60pjpmu6neaeaga.us.auth0.com',
  })
  assert.equal(
    source.theme.widget && (source.theme.widget as JsonObject).logo_url,
    'https://dev.boxlite.ai/auth0/boxlite-light-ec0b1243.png',
  )
  assert.equal(source.prompts[0].text.login && (source.prompts[0].text.login as JsonObject).title, 'Welcome back')
  assert.equal(
    source.prompts[1].text.signup && (source.prompts[1].text.signup as JsonObject).title,
    'Welcome to BoxLite',
  )
  assert.equal('_comment' in source.theme, false)
  assert.equal('_comment' in source.prompts[0].text, false)
})

test('the dashboard ships only the documented content-addressed Auth0 assets', () => {
  const root = join(import.meta.dirname, '..', '..', 'dashboard', 'public', 'auth0')
  const expectedHashes = {
    'IBM-Plex-OFL-d741e57d.txt': 'd741e57d5f865e294df801f96b7b5161a88b211df65887e4358d271c9fc5fb4f',
    'boxlite-light-ec0b1243.png': 'ec0b124340e956a6619e866809e2dad8e5f75e83e10a301c766ecdd81710f8e0',
    'ibm-plex-mono-400-ba204497.woff2': 'ba204497f16b6d334cee9d1e963a831b73e3a56e1d6300a8489d18df7214b350',
  }
  assert.deepEqual(readdirSync(root).sort(), Object.keys(expectedHashes).sort())
  for (const [fileName, expectedHash] of Object.entries(expectedHashes)) {
    const actualHash = createHash('sha256')
      .update(readFileSync(join(root, fileName)))
      .digest('hex')
    assert.equal(actualHash, expectedHash, fileName)
    assert.match(fileName.toLowerCase(), new RegExp(expectedHash.slice(0, 8)), fileName)
  }
})

test('the HTTP verifier checks live stack identity before CORS-enabled assets', async () => {
  const calls: string[] = []
  const verifier = new HttpBrandingVerifier({
    fetch: async (input, init) => {
      const url = String(input)
      calls.push(url)
      if (url.endsWith('/api/config')) {
        return Response.json({ dashboardUrl: TARGET.stackOrigin, oidc: { issuer: TARGET.publicOidcIssuer } })
      }
      assert.equal(new Headers(init?.headers).get('origin'), 'https://auth.dev.example.com')
      return new Response('asset', {
        headers: {
          'access-control-allow-origin': '*',
          'content-type': url.endsWith('.png') ? 'image/png' : 'font/woff2',
        },
      })
    },
  })

  assert.deepEqual(await verifier.verify(TARGET, [THEME.widget.logo_url, THEME.fonts.font_url]), [
    'stack identity',
    'OIDC issuer',
    `asset ${THEME.widget.logo_url}`,
    `asset ${THEME.fonts.font_url}`,
  ])
  assert.deepEqual(calls, ['https://api.dev.example.com/api/config', THEME.widget.logo_url, THEME.fonts.font_url])
})

test('the HTTP verifier rejects a mismatched live issuer before probing assets', async () => {
  const calls: string[] = []
  const verifier = new HttpBrandingVerifier({
    fetch: async (input) => {
      calls.push(String(input))
      return Response.json({ dashboardUrl: TARGET.stackOrigin, oidc: { issuer: 'https://other.example.com/' } })
    },
  })
  await assert.rejects(() => verifier.verify(TARGET, [THEME.widget.logo_url]), /identifies OIDC issuer/)
  assert.deepEqual(calls, ['https://api.dev.example.com/api/config'])
})

test('the HTTP verifier rejects an HTML SPA fallback and oversized assets', async () => {
  const config = Response.json({ dashboardUrl: TARGET.stackOrigin, oidc: { issuer: TARGET.publicOidcIssuer } })
  let call = 0
  const htmlVerifier = new HttpBrandingVerifier({
    fetch: async () =>
      call++ === 0
        ? config
        : new Response('<html>', { headers: { 'access-control-allow-origin': '*', 'content-type': 'text/html' } }),
  })
  await assert.rejects(() => htmlVerifier.verify(TARGET, [THEME.widget.logo_url]), /Content-Type 'text\/html'/)

  call = 0
  const oversizedVerifier = new HttpBrandingVerifier({
    maxAssetBytes: 4,
    fetch: async () =>
      call++ === 0
        ? Response.json({ dashboardUrl: TARGET.stackOrigin, oidc: { issuer: TARGET.publicOidcIssuer } })
        : new Response('12345', {
            headers: { 'access-control-allow-origin': '*', 'content-type': 'image/png' },
          }),
  })
  await assert.rejects(() => oversizedVerifier.verify(TARGET, [THEME.widget.logo_url]), /4-byte download limit/)
})

test('the CLI requires an explicit action and stage', () => {
  assert.deepEqual(parseUniversalLoginArgs(['--help']), { action: 'help', stage: '', yes: false })
  assert.deepEqual(parseUniversalLoginArgs(['preview', '--stage', 'dev']), {
    action: 'preview',
    stage: 'dev',
    yes: false,
  })
  assert.throws(() => parseUniversalLoginArgs(['preview']), /--stage is required/)
  assert.throws(() => parseUniversalLoginArgs(['--stage', 'dev']), /action must be preview or apply/)
  assert.throws(() => parseUniversalLoginArgs(['destroy', '--stage', 'dev']), /action must be preview or apply/)
})

test('SIGINT aborts an interactive apply confirmation', async () => {
  const { branding } = service()
  const input = new PassThrough()
  const output = new PassThrough()
  const controller = new AbortController()
  output.on('data', (chunk) => {
    if (!chunk.toString().includes('Type "dev"')) return
    controller.abort(new Error('operator interrupted'))
    setImmediate(() => input.write('wrong-stage\n'))
  })

  await assert.rejects(
    () =>
      runUniversalLoginCommand(
        ['apply', '--stage', 'dev'],
        { branding, input, output, isTty: true },
        controller.signal,
      ),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  )
})

test('the Auth0 adapter pins every call to the catalog tenant without interactivity', async () => {
  const calls: string[][] = []
  const cli = new Auth0ManagementCli({
    execute: async (args) => {
      calls.push(args)
      if (args[1] === 'get') return args[2] === 'branding/themes/default' ? { themeId: 'thm_1' } : {}
      return {}
    },
  })

  await cli.getDefaultTheme(TARGET)
  await cli.getPromptText(TARGET, 'login', 'en')
  await cli.updateTheme(TARGET, 'thm_1', THEME)
  await cli.putPromptText(TARGET, 'login', 'en', PROMPTS[0].text)

  assert.equal(calls.length, 4)
  for (const args of calls) {
    assert.deepEqual(args.slice(-4), ['--tenant', TARGET.auth0TenantDomain, '--no-input', '--no-color'])
  }
  assert.equal(
    calls.some((args) => args.slice(0, 2).join(' ') === 'tenants use'),
    false,
  )
})

test('the Auth0 adapter treats only an explicit 404 as an absent resource', async () => {
  const missing = new Auth0ManagementCli({
    execute: async () => {
      throw Object.assign(new Error('missing'), { stderr: 'Request failed with status code 404' })
    },
  })
  assert.equal(await missing.getDefaultTheme(TARGET), null)
  assert.deepEqual(await missing.getPromptText(TARGET, 'login', 'en'), {})

  const unauthorized = new Auth0ManagementCli({
    execute: async () => {
      throw Object.assign(new Error('unauthorized'), { stderr: 'Request failed with status code 401' })
    },
  })
  await assert.rejects(() => unauthorized.getDefaultTheme(TARGET), /unauthorized/)
})
