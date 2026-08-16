// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import test from 'node:test'

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  bindActionArgs,
  brandingThemeArgs,
  createActionArgs,
  customApiArgs,
  defaultThemeArgs,
  deployActionArgs,
  enableRpLogoutDiscoveryArgs,
  pageTemplateArgs,
  spaApplicationArgs,
  templateAssetUrls,
  themeAssetUrls,
} from './auth0.js'

const AUTH0_ASSETS = join(import.meta.dirname, 'auth0')
const CHECKED_IN_THEME = JSON.parse(readFileSync(join(AUTH0_ASSETS, 'branding-theme.json'), 'utf8'))
const CHECKED_IN_TEMPLATE = readFileSync(join(AUTH0_ASSETS, 'page-template.liquid'), 'utf8')

function theme(overrides = {}) {
  return { colors: { page_background: '#13161B' }, fonts: { reference_text_size: 13 },
           widget: { logo_url: 'https://assets.example.com/logo.png' }, ...overrides }
}

function valueAfter(args: any, flag: any) {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

test('spaApplicationArgs registers both the dashboard and the CLI loopback callback', () => {
  const args = spaApplicationArgs({ stackDomain: 'dev.example.com' })
  // RFC 8252 §8.3 requires the IPv4 loopback literal, not `localhost`.
  assert.equal(valueAfter(args, '--callbacks'), 'https://dev.example.com,http://127.0.0.1:5555/callback')
  assert.equal(valueAfter(args, '--logout-urls'), 'https://dev.example.com')
  assert.equal(valueAfter(args, '--type'), 'spa')
})

test('spaApplicationArgs rejects a URL where a hostname is required', () => {
  assert.throws(() => spaApplicationArgs({ stackDomain: 'https://dev.example.com' }), /must be a bare hostname/)
  assert.throws(() => spaApplicationArgs({ stackDomain: '' }), /must be a bare hostname/)
})

test('customApiArgs derives the identifier that becomes OIDC_AUDIENCE', () => {
  assert.equal(valueAfter(customApiArgs({ stackDomain: 'dev.example.com' }), '--identifier'), 'https://dev.example.com/api')
})

test('createActionArgs targets the post-login trigger with the supplied body', () => {
  const args = createActionArgs({ code: 'exports.onExecutePostLogin = async () => {}' })
  assert.equal(valueAfter(args, '--trigger'), 'post-login')
  assert.equal(valueAfter(args, '--code'), 'exports.onExecutePostLogin = async () => {}')
})

test('createActionArgs refuses an empty Action body', () => {
  assert.throws(() => createActionArgs({ code: '   ' }), /Action body is required/)
})

test('deployActionArgs deploys by id, which is a distinct step from binding', () => {
  assert.deepEqual(deployActionArgs('act_123'), ['actions', 'deploy', 'act_123'])
  assert.throws(() => deployActionArgs(''), /actionId is required/)
})

test('bindActionArgs binds the deployed Action to the post-login flow', () => {
  const args = bindActionArgs({ actionId: 'act_123' })
  assert.deepEqual(args.slice(0, 3), ['api', 'patch', 'actions/triggers/post-login/bindings'])
  assert.deepEqual(JSON.parse(valueAfter(args, '--data')), {
    bindings: [{ ref: { type: 'action_id', value: 'act_123' }, display_name: 'boxlite-custom-claims' }],
  })
})

test('bindActionArgs preserves other bindings already on the flow', () => {
  // The PATCH replaces the entire binding list, so an unrelated Action already
  // on the post-login flow must be carried through or it is silently unbound.
  const args = bindActionArgs({
    actionId: 'act_new',
    existingBindings: [{ action: { id: 'act_other' }, display_name: 'someone-elses-action' }],
  })
  assert.deepEqual(JSON.parse(valueAfter(args, '--data')).bindings, [
    { ref: { type: 'action_id', value: 'act_other' }, display_name: 'someone-elses-action' },
    { ref: { type: 'action_id', value: 'act_new' }, display_name: 'boxlite-custom-claims' },
  ])
})

test('bindActionArgs skips a binding whose Action is gone instead of throwing', () => {
  // A binding can arrive with no `action` object once the Action behind it is
  // gone. Dereferencing that while rebuilding the list throws before the PATCH
  // is built, so bootstrap dies with the new Action deployed but never bound —
  // nothing is unbound, but the stage is left half-provisioned.
  const args = bindActionArgs({
    actionId: 'act_new',
    existingBindings: [{ display_name: 'legacy-orphan' }, { action: { id: 'act_other' }, display_name: 'keeper' }],
  })
  assert.deepEqual(JSON.parse(valueAfter(args, '--data')).bindings, [
    { ref: { type: 'action_id', value: 'act_other' }, display_name: 'keeper' },
    { ref: { type: 'action_id', value: 'act_new' }, display_name: 'boxlite-custom-claims' },
  ])
})

test('bindActionArgs does not duplicate itself when already bound', () => {
  const args = bindActionArgs({
    actionId: 'act_123',
    existingBindings: [{ action: { id: 'act_123' }, display_name: 'boxlite-custom-claims' }],
  })
  assert.deepEqual(JSON.parse(valueAfter(args, '--data')).bindings, [
    { ref: { type: 'action_id', value: 'act_123' }, display_name: 'boxlite-custom-claims' },
  ])
})

test('enableRpLogoutDiscoveryArgs flips the tenant logout-discovery setting', () => {
  const args = enableRpLogoutDiscoveryArgs()
  assert.deepEqual(args.slice(0, 3), ['api', 'patch', 'tenants/settings'])
  assert.deepEqual(JSON.parse(valueAfter(args, '--data')), {
    oidc_logout: { rp_logout_end_session_endpoint_discovery: true },
  })
})


test('brandingThemeArgs updates an existing theme by id and creates one when the tenant has none', () => {
  // A fresh tenant stores no theme at all, so the GET that precedes this 404s
  // and there is no id to PATCH — provisioning has to fall back to a create.
  assert.deepEqual(brandingThemeArgs({ themeId: 'thm_1', theme: theme() }).slice(0, 3), [
    'api',
    'patch',
    'branding/themes/thm_1',
  ])
  assert.deepEqual(brandingThemeArgs({ theme: theme() }).slice(0, 3), ['api', 'post', 'branding/themes'])
})

test('brandingThemeArgs strips the _comment keys the checked-in payload carries', () => {
  const args = brandingThemeArgs({
    themeId: 'thm_1',
    theme: { ...theme(), _comment: 'why these values', borders: { _comment_fine: 'why', buttons_style: 'sharp' } },
  })
  const sent = JSON.parse(valueAfter(args, '--data'))
  // The Management API rejects unknown fields, so a comment left in the payload
  // would fail the whole apply — and only against a real tenant, never here.
  assert.equal('_comment' in sent, false)
  assert.deepEqual(sent.borders, { buttons_style: 'sharp' })
})

test('brandingThemeArgs refuses a theme whose assets are not absolute https URLs', () => {
  // Auth0 accepts an unreachable logo without complaint, so a bad URL has to
  // fail here or not at all.
  assert.throws(
    () => brandingThemeArgs({ theme: theme({ widget: { logo_url: '/brand/logo.png' } }) }),
    /widget.logo_url must be an absolute https URL/,
  )
  assert.throws(() => brandingThemeArgs({ theme: { colors: {} } }), /needs at least colors and fonts/)
})

test('themeAssetUrls reports the theme-side asset bootstrap has to probe', () => {
  assert.deepEqual(themeAssetUrls(theme()), ['https://assets.example.com/logo.png'])
})

test('templateAssetUrls collects the fonts the template loads itself', () => {
  // fonts.font_url takes one URL and IBM Plex Mono has no variable face, so the
  // two weights are @font-face rules in the template — which means the probe
  // has to read them back out of the CSS rather than out of the theme.
  assert.deepEqual(
    templateAssetUrls(`
      @font-face { src: url('https://assets.example.com/mono-400.woff2') format('woff2'); }
      @font-face { src: url("https://assets.example.com/mono-500.woff2") format('woff2'); }
    `),
    ['https://assets.example.com/mono-400.woff2', 'https://assets.example.com/mono-500.woff2'],
  )
  assert.deepEqual(templateAssetUrls('<html></html>'), [])
})

test('the checked-in template declares both weights behind a monospace fallback', () => {
  // ULP's own stack ends in sans-serif, so a font that fails to load would take
  // the typography back to where it started while the run reports success.
  assert.equal(templateAssetUrls(CHECKED_IN_TEMPLATE).length, 2)
  assert.match(CHECKED_IN_TEMPLATE, /font-weight: 400/)
  assert.match(CHECKED_IN_TEMPLATE, /font-weight: 500/)
  assert.match(CHECKED_IN_TEMPLATE, /'IBM Plex Mono', ui-monospace,[^;]*monospace !important/)
  // The single-URL theme field must stay unused, or it would fight the above.
  assert.equal('font_url' in CHECKED_IN_THEME.fonts, false)
})

test('defaultThemeArgs reads the tenant theme rather than assuming one exists', () => {
  assert.deepEqual(defaultThemeArgs(), ['api', 'get', 'branding/themes/default'])
})

test('pageTemplateArgs refuses a template missing the markers Auth0 requires', () => {
  // Auth0 rejects these with an opaque 400, so the message is worth producing here.
  assert.throws(() => pageTemplateArgs('<html></html>'), /auth0:head.*auth0:widget|auth0:head/)
  assert.throws(() => pageTemplateArgs('{%- auth0:head -%}'), /auth0:widget/)
})

test('pageTemplateArgs wraps the template in the payload the API expects', () => {
  const template = '<html>{%- auth0:head -%}<body>{%- auth0:widget -%}</body></html>'
  const args = pageTemplateArgs(template)
  assert.deepEqual(args.slice(0, 3), ['api', 'put', 'branding/templates/universal-login'])
  assert.deepEqual(JSON.parse(valueAfter(args, '--data')), { template })
})

test('the checked-in theme and template are the ones bootstrap will actually send', () => {
  // Guards the assets, not the builders: these two files are edited by hand
  // when the design changes, and a typo in either only surfaces against a real
  // tenant otherwise.
  assert.doesNotThrow(() => brandingThemeArgs({ themeId: 'thm_1', theme: CHECKED_IN_THEME }))
  assert.doesNotThrow(() => pageTemplateArgs(CHECKED_IN_TEMPLATE))
  assert.equal(CHECKED_IN_THEME.borders.widget_corner_radius, 0)
  assert.equal(CHECKED_IN_THEME.fonts.reference_text_size, 13)
})
