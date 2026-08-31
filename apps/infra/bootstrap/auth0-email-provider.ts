// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'

import { assertJournalSnapshotSafe } from './auth0-login-policy.js'
import type { Auth0ManagementClient } from './auth0-login-policy.js'

type JsonObject = Record<string, any>

export interface Auth0EmailProviderOptions {
  tenant: string
  fromAddress: string
  region: string
  apply: boolean
}

export interface SesCredentials {
  accessKeyId: string
  secretAccessKey: string
}

export interface Auth0EmailProviderSources {
  templates: JsonObject[]
  receiptDirectory: string
}

interface Auth0EmailProviderState {
  provider: JsonObject | null
  templates: Map<string, JsonObject | null>
}

interface EmailProviderFingerprint {
  name: 'ses'
  enabled: true
  default_from_address: string
  region: string
}

interface Auth0EmailProviderReceipt {
  version: 1
  tenant: string
  createdAt: string
  provider: {
    created: boolean
    desired: EmailProviderFingerprint
  }
  templates: Array<{
    created: boolean
    desired: JsonObject
  }>
}

export function parseAuth0EmailProviderOptions(argv: string[]): Auth0EmailProviderOptions {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      tenant: { type: 'string' },
      from: { type: 'string' },
      region: { type: 'string' },
      apply: { type: 'boolean', default: false },
    },
  })

  const tenant = requireExactValue('--tenant', values.tenant)
  const fromAddress = requireExactValue('--from', values.from)
  const region = requireExactValue('--region', values.region)
  if (tenant.includes('/') || !tenant.includes('.')) throw new Error('--tenant must be an exact Auth0 tenant hostname')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromAddress) || /[\r\n]/.test(fromAddress)) {
    throw new Error('--from must be one bare email address')
  }
  if (fromAddress.toLowerCase().endsWith('@auth0.com')) throw new Error('--from must not use the auth0.com domain')
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(region)) throw new Error('--region must be an AWS region')

  return { tenant, fromAddress, region, apply: values.apply ?? false }
}

function requireExactValue(flag: string, value: string | undefined): string {
  if (!value) throw new Error(`${flag} is required`)
  if (value !== value.trim()) throw new Error(`${flag} must not contain leading or trailing whitespace`)
  return value
}

export function buildSesEmailProvider(options: Pick<Auth0EmailProviderOptions, 'fromAddress' | 'region'>): JsonObject {
  return {
    name: 'ses',
    enabled: true,
    default_from_address: options.fromAddress,
    credentials: { region: options.region },
  }
}

export function readAuth0CodeEmailTemplates(manifestPath: string): JsonObject[] {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!Array.isArray(manifest)) throw new Error(`Auth0 email-template manifest '${manifestPath}' must be a JSON array`)
  const manifestRoot = dirname(manifestPath)

  return manifest.map(({ render_html: renderHtml, ...template }) => {
    const name = template.template ?? 'unknown'
    if (typeof renderHtml !== 'string' || renderHtml.trim() === '') {
      throw new Error(`Auth0 email template '${name}' must point render_html at an HTML body file`)
    }
    const bodyPath = join(manifestRoot, renderHtml)
    try {
      // Auth0 stores the body verbatim and never echoes render_html back, so the manifest
      // reference is resolved away here to keep desired state comparable to tenant state.
      return { ...template, body: readFileSync(bodyPath, 'utf8').trim() }
    } catch (cause) {
      throw new Error(`Auth0 email template '${name}' cannot read render_html '${bodyPath}'`, { cause })
    }
  })
}

// Liquid permits filters and whitespace control on an interpolation, so the
// stock Auth0 bodies write `{{ code | escape }}`. Match the variable itself
// rather than one spelling of it, while still rejecting a body that never
// renders the code at all.
const CODE_VARIABLE = /\{\{-?\s*code\s*(?:\||-?\}\})/

export function buildAuth0CodeEmailTemplates(fromAddress: string, templates: JsonObject[]): JsonObject[] {
  const expectedNames = new Set(['verify_email_by_code', 'reset_email_by_code'])
  if (templates.length !== expectedNames.size) throw new Error('exactly two Auth0 code-email templates are required')

  return templates.map((template) => {
    if (!expectedNames.delete(template.template)) {
      throw new Error(`unexpected or duplicate Auth0 email template '${template.template ?? 'unknown'}'`)
    }
    if (!CODE_VARIABLE.test(template.body ?? '')) {
      throw new Error(`Auth0 email template '${template.template}' must render the code variable`)
    }
    return { ...structuredClone(template), from: fromAddress }
  })
}

export class Auth0EmailProviderConfigurator {
  private receipt: Auth0EmailProviderReceipt | null = null
  private receiptPath: string | null = null

  constructor(
    private readonly options: Auth0EmailProviderOptions,
    private readonly client: Auth0ManagementClient,
    private readonly sources: Auth0EmailProviderSources,
  ) {}

  preview(): JsonObject {
    const desiredProvider = buildSesEmailProvider(this.options)
    const desiredTemplates = buildAuth0CodeEmailTemplates(this.options.fromAddress, this.sources.templates)
    const state = this.readState(desiredTemplates)
    this.assertAdoptable(state, desiredProvider, desiredTemplates)

    return {
      mode: 'preview',
      tenant: this.options.tenant,
      provider: {
        name: 'ses',
        region: this.options.region,
        from: this.options.fromAddress,
        change: state.provider ? 'reuse' : 'create',
      },
      templates: desiredTemplates.map((template) => ({
        name: template.template,
        change: state.templates.get(template.template) ? 'reuse' : 'create',
      })),
      readyToApply: true,
    }
  }

  async apply(readCredentials: () => Promise<SesCredentials>): Promise<JsonObject> {
    const desiredProvider = buildSesEmailProvider(this.options)
    const desiredTemplates = buildAuth0CodeEmailTemplates(this.options.fromAddress, this.sources.templates)
    const state = this.readState(desiredTemplates)
    this.assertAdoptable(state, desiredProvider, desiredTemplates)
    this.beginReceipt(desiredProvider, desiredTemplates)
    const receipt = this.receipt
    if (!receipt) throw new Error('Auth0 email-provider receipt was not initialized')

    try {
      if (!state.provider) {
        const credentials = await readCredentials()
        this.client.request('post', 'emails/provider', {
          data: {
            ...desiredProvider,
            credentials: {
              ...desiredProvider.credentials,
              accessKeyId: requireCredential('SES access key ID', credentials.accessKeyId),
              secretAccessKey: requireCredential('SES secret access key', credentials.secretAccessKey),
            },
          },
        })
        receipt.provider.created = true
        this.flushReceipt()
      }

      for (const template of desiredTemplates) {
        if (state.templates.get(template.template)) continue
        this.client.request('post', 'email-templates', { data: template })
        const receiptEntry = receipt.templates.find((entry) => entry.desired.template === template.template)
        if (!receiptEntry) throw new Error(`Auth0 email template '${template.template}' has no receipt entry`)
        receiptEntry.created = true
        this.flushReceipt()
      }

      const readBack = this.readState(desiredTemplates)
      this.assertReady(readBack, desiredProvider, desiredTemplates)
      return {
        mode: 'applied',
        tenant: this.options.tenant,
        provider: 'ses',
        templates: desiredTemplates.map((template) => template.template),
        receipt: this.receiptPath,
      }
    } catch (cause) {
      throw new Error(
        `Auth0 email-provider apply stopped; inspect receipt ${JSON.stringify(this.receiptPath)} and rerun after fixing the cause`,
        { cause },
      )
    }
  }

  static rollback(receiptPath: string, client: Auth0ManagementClient): JsonObject {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Auth0EmailProviderReceipt
    if (receipt.version !== 1 || !receipt.tenant || !receipt.provider || !Array.isArray(receipt.templates)) {
      throw new Error(`invalid Auth0 email-provider receipt '${receiptPath}'`)
    }
    assertJournalSnapshotSafe('Auth0 email-provider receipt', receipt)
    const disabledTemplates: string[] = []

    for (const entry of [...receipt.templates].reverse()) {
      if (!entry.created) continue
      const templateName = entry.desired.template
      const current = objectOrNull(
        client.request('get', `email-templates/${encodeURIComponent(templateName)}`, { allowNotFound: true }),
      )
      if (!current) continue
      if (containsJson(current, { ...entry.desired, enabled: false })) continue
      if (!containsJson(current, entry.desired)) {
        throw new Error(`refusing to disable changed Auth0 email template '${templateName}'`)
      }
      client.request('patch', `email-templates/${encodeURIComponent(templateName)}`, { data: { enabled: false } })
      disabledTemplates.push(templateName)
    }

    let providerDeleted = false
    if (receipt.provider.created) {
      const current = readProvider(client)
      if (current) {
        if (!matchesProviderFingerprint(current, receipt.provider.desired)) {
          throw new Error('refusing to delete changed Auth0 email provider')
        }
        client.request('delete', 'emails/provider')
        providerDeleted = true
      }
    }

    return {
      mode: 'rolled-back',
      tenant: receipt.tenant,
      providerDeleted,
      disabledTemplates,
    }
  }

  private readState(desiredTemplates: JsonObject[]): Auth0EmailProviderState {
    return {
      provider: readProvider(this.client),
      templates: new Map(
        desiredTemplates.map((template) => [
          template.template,
          objectOrNull(
            this.client.request('get', `email-templates/${encodeURIComponent(template.template)}`, {
              allowNotFound: true,
            }),
          ),
        ]),
      ),
    }
  }

  private assertAdoptable(
    state: Auth0EmailProviderState,
    desiredProvider: JsonObject,
    desiredTemplates: JsonObject[],
  ): void {
    if (state.provider && !containsJson(state.provider, desiredProvider)) {
      throw new Error('Auth0 has a different email provider; refusing tenant-wide credential or sender replacement')
    }
    for (const desired of desiredTemplates) {
      const existing = state.templates.get(desired.template)
      if (existing && !containsJson(existing, desired)) {
        throw new Error(`Auth0 email template '${desired.template}' differs from the checked-in BoxLite template`)
      }
    }
  }

  private assertReady(
    state: Auth0EmailProviderState,
    desiredProvider: JsonObject,
    desiredTemplates: JsonObject[],
  ): void {
    if (!state.provider || !containsJson(state.provider, desiredProvider)) {
      throw new Error('Auth0 SES email provider read-back does not match the requested configuration')
    }
    for (const desired of desiredTemplates) {
      const existing = state.templates.get(desired.template)
      if (!existing || !containsJson(existing, desired)) {
        throw new Error(`Auth0 email template '${desired.template}' read-back does not match the checked-in template`)
      }
    }
  }

  private beginReceipt(desiredProvider: JsonObject, desiredTemplates: JsonObject[]): void {
    mkdirSync(this.sources.receiptDirectory, { recursive: true, mode: 0o700 })
    this.receiptPath = join(
      this.sources.receiptDirectory,
      `email-provider-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`,
    )
    this.receipt = {
      version: 1,
      tenant: this.options.tenant,
      createdAt: new Date().toISOString(),
      provider: { created: false, desired: fingerprintProvider(desiredProvider) },
      templates: desiredTemplates.map((desired) => ({ created: false, desired: structuredClone(desired) })),
    }
    this.flushReceipt()
  }

  private flushReceipt(): void {
    if (!this.receipt || !this.receiptPath) throw new Error('Auth0 email-provider receipt was not initialized')
    assertJournalSnapshotSafe('Auth0 email-provider receipt', this.receipt)
    writeFileSync(this.receiptPath, `${JSON.stringify(this.receipt, null, 2)}\n`, { mode: 0o600 })
  }
}

function readProvider(client: Auth0ManagementClient): JsonObject | null {
  return objectOrNull(
    client.request('get', 'emails/provider', {
      allowNotFound: true,
      query: {
        fields: 'name,enabled,default_from_address,credentials,settings',
        include_fields: 'true',
      },
    }),
  )
}

function fingerprintProvider(provider: JsonObject): EmailProviderFingerprint {
  return {
    name: 'ses',
    enabled: true,
    default_from_address: provider.default_from_address,
    region: provider.credentials?.region,
  }
}

function matchesProviderFingerprint(actual: JsonObject, expected: EmailProviderFingerprint): boolean {
  return (
    actual.name === expected.name &&
    actual.enabled === expected.enabled &&
    actual.default_from_address === expected.default_from_address &&
    actual.credentials?.region === expected.region
  )
}

function requireCredential(label: string, value: string): string {
  const trimmed = value?.trim()
  if (!trimmed) throw new Error(`${label} cannot be empty`)
  return trimmed
}

function objectOrNull(value: JsonObject | JsonObject[] | null): JsonObject | null {
  return value && !Array.isArray(value) ? value : null
}

function containsJson(actual: any, desired: any): boolean {
  if (Array.isArray(desired)) {
    return (
      Array.isArray(actual) &&
      desired.length === actual.length &&
      desired.every((item, i) => containsJson(actual[i], item))
    )
  }
  if (desired && typeof desired === 'object') {
    return Boolean(
      actual &&
      typeof actual === 'object' &&
      Object.entries(desired).every(([key, value]) => containsJson(actual[key], value)),
    )
  }
  return actual === desired
}
