// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  Auth0EmailProviderConfigurator,
  buildAuth0CodeEmailTemplates,
  parseAuth0EmailProviderOptions,
  readAuth0CodeEmailTemplates,
} from './auth0-email-provider.js'
import type { Auth0ManagementClient } from './auth0-login-policy.js'

type JsonObject = Record<string, any>

function sourceTemplates(): JsonObject[] {
  return readAuth0CodeEmailTemplates(fileURLToPath(new URL('./auth0/email-templates.json', import.meta.url)))
}

function options(apply = false) {
  return {
    tenant: 'tenant.us.auth0.com',
    fromAddress: 'no-reply@boxlite.example',
    provider: { kind: 'ses' as const, region: 'us-east-1' },
    apply,
  }
}

function templatesOnlyOptions(apply = false) {
  return {
    tenant: 'tenant.us.auth0.com',
    fromAddress: 'no-reply@boxlite.example',
    provider: { kind: 'existing' as const },
    apply,
  }
}

/** A tenant whose provider this repo does not know how to build. */
function resendProvider() {
  return { name: 'resend', enabled: true, default_from_address: 'no-reply@boxlite.example', credentials: {} }
}

test('parseAuth0EmailProviderOptions requires an exact tenant, sender, and AWS region', () => {
  assert.deepEqual(
    parseAuth0EmailProviderOptions([
      '--tenant',
      'tenant.us.auth0.com',
      '--from',
      'no-reply@boxlite.example',
      '--region',
      'us-east-1',
    ]),
    options(),
  )
  assert.throws(
    () =>
      parseAuth0EmailProviderOptions([
        '--tenant',
        'tenant.us.auth0.com',
        '--from',
        'sender@auth0.com',
        '--region',
        'us-east-1',
      ]),
    /must not use the auth0.com domain/,
  )
  assert.throws(
    () =>
      parseAuth0EmailProviderOptions([
        '--tenant',
        'tenant.us.auth0.com',
        '--from',
        'no-reply@boxlite.example',
        '--region',
        'not-a-region',
      ]),
    /must be an AWS region/,
  )
})

test('parseAuth0EmailProviderOptions selects the template-only half without an AWS region', () => {
  assert.deepEqual(
    parseAuth0EmailProviderOptions([
      '--tenant',
      'tenant.us.auth0.com',
      '--from',
      'no-reply@boxlite.example',
      '--templates-only',
    ]),
    templatesOnlyOptions(),
  )
  // The two halves must not be requested at once: --region is SES's own
  // parameter and would silently pick the provider half.
  assert.throws(
    () =>
      parseAuth0EmailProviderOptions([
        '--tenant',
        'tenant.us.auth0.com',
        '--from',
        'no-reply@boxlite.example',
        '--templates-only',
        '--region',
        'us-east-1',
      ]),
    /--region must be omitted/,
  )
  assert.throws(
    () => parseAuth0EmailProviderOptions(['--tenant', 'tenant.us.auth0.com', '--from', 'no-reply@boxlite.example']),
    /--region is required to create the SES provider/,
  )
})

test('checked-in Auth0 code templates render a code and receive the selected sender', () => {
  const templates = buildAuth0CodeEmailTemplates('no-reply@boxlite.example', sourceTemplates())

  assert.deepEqual(templates.map((template) => template.template).sort(), [
    'reset_email_by_code',
    'verify_email_by_code',
  ])
  assert.equal(
    templates.every((template) => template.from === 'no-reply@boxlite.example'),
    true,
  )
  assert.equal(
    templates.every((template) => !('render_html' in template)),
    true,
  )
  // The build above is the positive check: it throws unless every checked-in
  // body renders the code variable, whichever Liquid filters it uses.
  assert.throws(
    () =>
      buildAuth0CodeEmailTemplates(
        'no-reply@boxlite.example',
        sourceTemplates().map((template) => ({ ...template, body: '<p>Sign in to BoxLite.</p>' })),
      ),
    /must render the code variable/,
  )
})

test('Auth0 email-provider preview is read-only and refuses conflicting tenant configuration', () => {
  const calls: Array<{ method: string; path: string }> = []
  const client: Auth0ManagementClient = {
    request(method, path) {
      calls.push({ method, path })
      if (path === 'emails/provider') return null
      return null
    },
  }
  const configurator = new Auth0EmailProviderConfigurator(options(), client, {
    templates: sourceTemplates(),
    receiptDirectory: '/unused',
  })

  const preview = configurator.preview()

  assert.equal(preview.mode, 'preview')
  assert.equal(preview.provider.change, 'create')
  assert.equal(
    preview.templates.every((template: JsonObject) => template.change === 'create'),
    true,
  )
  assert.equal(
    calls.every((call) => call.method === 'get'),
    true,
  )

  const conflictingClient: Auth0ManagementClient = {
    request(_method, path) {
      if (path === 'emails/provider') {
        return {
          name: 'smtp',
          enabled: true,
          default_from_address: 'other@example.com',
        }
      }
      return null
    },
  }
  assert.throws(
    () =>
      new Auth0EmailProviderConfigurator(options(), conflictingClient, {
        templates: sourceTemplates(),
        receiptDirectory: '/unused',
      }).preview(),
    /different email provider/,
  )
})

test('Auth0 email-provider apply is idempotent, keeps SES secrets out of its receipt, and rolls back owned resources', async () => {
  const receiptDirectory = mkdtempSync(join(tmpdir(), 'boxlite-auth0-email-'))
  const calls: Array<{ method: string; path: string; data?: JsonObject }> = []
  const state: {
    provider: JsonObject | null
    templates: Map<string, JsonObject>
  } = {
    provider: null,
    templates: new Map(),
  }
  const client: Auth0ManagementClient = {
    request(method, path, requestOptions = {}) {
      calls.push({ method, path, data: requestOptions.data as JsonObject | undefined })
      if (method === 'get' && path === 'emails/provider') return state.provider
      if (method === 'get' && path.startsWith('email-templates/')) {
        return state.templates.get(path.slice('email-templates/'.length)) ?? null
      }
      if (method === 'post' && path === 'emails/provider') {
        const provider = requestOptions.data as JsonObject
        state.provider = {
          name: provider.name,
          enabled: provider.enabled,
          default_from_address: provider.default_from_address,
          credentials: { region: provider.credentials.region },
        }
        return state.provider
      }
      if (method === 'post' && path === 'email-templates') {
        const template = structuredClone(requestOptions.data as JsonObject)
        state.templates.set(template.template, template)
        return template
      }
      if (method === 'patch' && path.startsWith('email-templates/')) {
        const templateName = path.slice('email-templates/'.length)
        const template = state.templates.get(templateName)
        if (!template) throw new Error(`cannot patch missing template '${templateName}'`)
        Object.assign(template, requestOptions.data)
        return template
      }
      if (method === 'delete' && path === 'emails/provider') {
        state.provider = null
        return null
      }
      throw new Error(`unexpected Auth0 request ${method} ${path}`)
    },
  }

  try {
    const configurator = new Auth0EmailProviderConfigurator(options(true), client, {
      templates: sourceTemplates(),
      receiptDirectory,
    })
    const result = await configurator.apply(async () => ({
      accessKeyId: 'example-access-key',
      secretAccessKey: 'example-secret-key',
    }))
    const receiptPath = result.receipt as string
    const receipt = readFileSync(receiptPath, 'utf8')

    assert.equal(result.mode, 'applied')
    assert.equal(statSync(receiptPath).mode & 0o777, 0o600)
    assert.equal(receipt.includes('example-access-key'), false)
    assert.equal(receipt.includes('example-secret-key'), false)
    assert.equal(receipt.includes('credentials'), false)
    assert.equal(state.templates.size, 2)
    assert.equal(calls.filter((call) => call.method === 'post').length, 3)

    let credentialsRequested = false
    await new Auth0EmailProviderConfigurator(options(true), client, {
      templates: sourceTemplates(),
      receiptDirectory,
    }).apply(async () => {
      credentialsRequested = true
      throw new Error('matching provider must not request credentials')
    })

    assert.equal(credentialsRequested, false)
    assert.equal(calls.filter((call) => call.method === 'post').length, 3)

    const rollback = Auth0EmailProviderConfigurator.rollback(receiptPath, client)

    assert.equal(rollback.providerDeleted, true)
    assert.equal(state.provider, null)
    assert.equal(
      [...state.templates.values()].every((template) => template.enabled === false),
      true,
    )

    const repeatedRollback = Auth0EmailProviderConfigurator.rollback(receiptPath, client)
    assert.equal(repeatedRollback.providerDeleted, false)
    assert.deepEqual(repeatedRollback.disabledTemplates, [])
  } finally {
    rmSync(receiptDirectory, { recursive: true, force: true })
  }
})

test('Auth0 email-provider reconciles the code templates on a tenant whose provider it cannot build', async () => {
  const receiptDirectory = mkdtempSync(join(tmpdir(), 'boxlite-auth0-email-'))
  const calls: Array<{ method: string; path: string }> = []
  const templates = new Map<string, JsonObject>()
  const client: Auth0ManagementClient = {
    request(method, path, requestOptions = {}) {
      calls.push({ method, path })
      if (method === 'get' && path === 'emails/provider') return resendProvider()
      if (method === 'get' && path.startsWith('email-templates/')) {
        return templates.get(path.slice('email-templates/'.length)) ?? null
      }
      if (method === 'post' && path === 'email-templates') {
        const template = structuredClone(requestOptions.data as JsonObject)
        templates.set(template.template, template)
        return template
      }
      if (method === 'patch' && path.startsWith('email-templates/')) {
        const template = templates.get(path.slice('email-templates/'.length))
        if (!template) throw new Error(`cannot patch missing template '${path}'`)
        Object.assign(template, requestOptions.data)
        return template
      }
      throw new Error(`unexpected Auth0 request ${method} ${path}`)
    },
  }

  try {
    const result = await new Auth0EmailProviderConfigurator(templatesOnlyOptions(true), client, {
      templates: sourceTemplates(),
      receiptDirectory,
    }).apply(async () => {
      throw new Error('a run that owns no provider must not request SES credentials')
    })

    assert.equal(result.mode, 'applied')
    // The tenant keeps the provider it had; only the templates were written.
    assert.equal(result.provider, 'resend')
    assert.deepEqual([...templates.keys()].sort(), ['reset_email_by_code', 'verify_email_by_code'])
    assert.equal(
      [...templates.values()].every((template) => template.enabled === true),
      true,
    )
    assert.deepEqual(
      calls.filter((call) => call.path === 'emails/provider' && call.method !== 'get'),
      [],
    )
    const receipt = JSON.parse(readFileSync(result.receipt as string, 'utf8'))
    assert.equal(receipt.provider.created, false)
    assert.equal(receipt.provider.desired, null)

    // Nothing to undo on the provider side, and the templates it did create
    // are still disabled by the same rollback.
    const rollback = Auth0EmailProviderConfigurator.rollback(result.receipt as string, client)
    assert.equal(rollback.providerDeleted, false)
    assert.deepEqual((rollback.disabledTemplates as string[]).sort(), [
      'reset_email_by_code',
      'verify_email_by_code',
    ])
  } finally {
    rmSync(receiptDirectory, { recursive: true, force: true })
  }
})

test('Auth0 email-provider template-only runs refuse a tenant the login policy would refuse', () => {
  const configurator = (provider: JsonObject | null, fromAddress = 'no-reply@boxlite.example') =>
    new Auth0EmailProviderConfigurator(
      { ...templatesOnlyOptions(), fromAddress },
      {
        request(method, path) {
          if (method === 'get' && path === 'emails/provider') return provider
          return null
        },
      },
      { templates: sourceTemplates(), receiptDirectory: '/unused' },
    )

  // Exactly the states emailDeliveryReadiness rejects: absent, Auth0's own
  // built-in test sender, and a configured-but-disabled provider.
  assert.throws(() => configurator(null).preview(), /needs an enabled non-Auth0 email provider/)
  assert.throws(
    () => configurator({ name: 'auth0', enabled: true }).preview(),
    /needs an enabled non-Auth0 email provider/,
  )
  assert.throws(
    () => configurator({ ...resendProvider(), enabled: false }).preview(),
    /needs an enabled non-Auth0 email provider/,
  )
  // A sender the provider cannot send as would only surface as a failed signup.
  assert.throws(
    () => configurator(resendProvider(), 'codes@boxlite.example').preview(),
    /is not the tenant provider's sender/,
  )
  assert.equal(configurator(resendProvider()).preview().provider.change, 'keep')
})

test('Auth0 login-policy login requests the email-provider write scopes used by apply and rollback', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const loginCommand = packageJson.scripts['auth0:login-policy-login']

  for (const scope of [
    'create:email_provider',
    'delete:email_provider',
    'create:email_templates',
    'update:email_templates',
  ]) {
    assert.match(loginCommand, new RegExp(`(?:^|,)${scope}(?:,|$)`))
  }
  assert.equal(packageJson.scripts['auth0:configure-email'], 'tsx bootstrap/configure-auth0-email.ts')
})
