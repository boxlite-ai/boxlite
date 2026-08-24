// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  bindActionArgs,
  brandingThemeArgs,
  createActionArgs,
  customApiArgs,
  defaultThemeArgs,
  deployActionArgs,
  enableRpLogoutDiscoveryArgs,
  customTextArgs,
  customTextRequests,
  isAuth0ApiNotFound,
  prepareAuth0Branding,
  resolveAuth0BrandingAssets,
  spaApplicationArgs,
  themeAssetUrls,
  validatePublishedAssetResponse,
} from './auth0.js'

const AUTH0_ASSETS = join(import.meta.dirname, 'auth0')
const CHECKED_IN_THEME = JSON.parse(readFileSync(join(AUTH0_ASSETS, 'branding-theme.json'), 'utf8'))
const CHECKED_IN_TEXT = JSON.parse(readFileSync(join(AUTH0_ASSETS, 'custom-text.json'), 'utf8'))
const DASHBOARD_AUTH0_ASSETS = join(import.meta.dirname, '..', '..', 'dashboard', 'public', 'auth0')
const RESOLVED_CHECKED_IN = resolveAuth0BrandingAssets({
  theme: CHECKED_IN_THEME,
  stackDomain: 'dev.boxlite.example',
})

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
  assert.throws(
    () => brandingThemeArgs({ theme: theme({ fonts: { font_url: '/brand/font.woff2' } }) }),
    /fonts.font_url must be an absolute https URL/,
  )
  assert.throws(() => brandingThemeArgs({ theme: { colors: {} } }), /needs at least colors and fonts/)
})

test('resolveAuth0BrandingAssets binds checked-in assets to the selected stack domain', () => {
  const resolved = resolveAuth0BrandingAssets({
    theme: CHECKED_IN_THEME,
    stackDomain: 'dev.boxlite.example',
  })

  assert.equal(resolved.theme.widget.logo_url, 'https://dev.boxlite.example/auth0/boxlite-light-ec0b1243.png')
  assert.equal(resolved.theme.fonts.font_url, 'https://dev.boxlite.example/auth0/ibm-plex-mono-400-ba204497.woff2')
  assert.doesNotMatch(JSON.stringify(resolved), /pages\.dev|__BOXLITE_STACK_DOMAIN__/)
  assert.throws(() => resolveAuth0BrandingAssets({ theme: CHECKED_IN_THEME, stackDomain: '' }), /stackDomain/)
})

test('themeAssetUrls reports the theme-side asset bootstrap has to probe', () => {
  assert.deepEqual(themeAssetUrls(theme()), ['https://assets.example.com/logo.png'])
  assert.deepEqual(themeAssetUrls(theme({ fonts: { font_url: 'https://assets.example.com/mono.woff2' } })), [
    'https://assets.example.com/logo.png',
    'https://assets.example.com/mono.woff2',
  ])
})

test('validatePublishedAssetResponse requires a successful CORS-enabled asset', () => {
  assert.doesNotThrow(() =>
    validatePublishedAssetResponse({
      url: 'https://assets.example.com/mono.woff2',
      status: 200,
      bodyLength: 42,
      contentType: 'font/woff2',
      allowOrigin: '*',
      auth0Origin: 'https://auth.example.com',
    }),
  )
  assert.doesNotThrow(() =>
    validatePublishedAssetResponse({
      url: 'https://assets.example.com/mono.woff2',
      status: 200,
      bodyLength: 42,
      contentType: 'font/woff2; charset=binary',
      allowOrigin: 'https://auth.example.com',
      auth0Origin: 'https://auth.example.com',
    }),
  )
  assert.throws(
    () =>
      validatePublishedAssetResponse({
        url: 'https://assets.example.com/mono.woff2',
        status: 302,
        bodyLength: 42,
        contentType: 'font/woff2',
        allowOrigin: '*',
        auth0Origin: 'https://auth.example.com',
      }),
    /returned 302/,
  )
  assert.throws(
    () =>
      validatePublishedAssetResponse({
        url: 'https://assets.example.com/mono.woff2',
        status: 404,
        bodyLength: 42,
        contentType: 'font/woff2',
        allowOrigin: '*',
        auth0Origin: 'https://auth.example.com',
      }),
    /returned 404/,
  )
  assert.throws(
    () =>
      validatePublishedAssetResponse({
        url: 'https://assets.example.com/mono.woff2',
        status: 200,
        bodyLength: 42,
        contentType: 'font/woff2',
        allowOrigin: null,
        auth0Origin: 'https://auth.example.com',
      }),
    /Access-Control-Allow-Origin/,
  )
  assert.throws(
    () =>
      validatePublishedAssetResponse({
        url: 'https://assets.example.com/mono.woff2',
        status: 200,
        bodyLength: 0,
        contentType: 'font/woff2',
        allowOrigin: '*',
        auth0Origin: 'https://auth.example.com',
      }),
    /empty body/,
  )
  assert.throws(
    () =>
      validatePublishedAssetResponse({
        url: 'https://assets.example.com/logo.png',
        status: 200,
        bodyLength: 42,
        contentType: 'text/html; charset=UTF-8',
        allowOrigin: '*',
        auth0Origin: 'https://auth.example.com',
      }),
    /Content-Type 'text\/html; charset=UTF-8'.*image\/png/,
  )
})

test('the checked-in Free-plan theme carries the regular font face', () => {
  const resolved = resolveAuth0BrandingAssets({
    theme: CHECKED_IN_THEME,
    stackDomain: 'dev.boxlite.example',
  })
  assert.equal(resolved.theme.fonts.font_url, 'https://dev.boxlite.example/auth0/ibm-plex-mono-400-ba204497.woff2')
  assert.deepEqual(themeAssetUrls(resolved.theme), [
    'https://dev.boxlite.example/auth0/boxlite-light-ec0b1243.png',
    'https://dev.boxlite.example/auth0/ibm-plex-mono-400-ba204497.woff2',
  ])
})

test('the dashboard ships only the documented content-addressed Auth0 assets', () => {
  const expectedHashes = {
    'IBM-Plex-OFL-d741e57d.txt': 'd741e57d5f865e294df801f96b7b5161a88b211df65887e4358d271c9fc5fb4f',
    'boxlite-light-ec0b1243.png': 'ec0b124340e956a6619e866809e2dad8e5f75e83e10a301c766ecdd81710f8e0',
    'ibm-plex-mono-400-ba204497.woff2': 'ba204497f16b6d334cee9d1e963a831b73e3a56e1d6300a8489d18df7214b350',
  }

  assert.deepEqual(readdirSync(DASHBOARD_AUTH0_ASSETS).sort(), Object.keys(expectedHashes).sort())
  for (const [fileName, expectedHash] of Object.entries(expectedHashes)) {
    const body = readFileSync(join(DASHBOARD_AUTH0_ASSETS, fileName))
    assert.equal(createHash('sha256').update(body).digest('hex'), expectedHash, fileName)
    assert.match(fileName.toLowerCase(), new RegExp(expectedHash.slice(0, 8)), fileName)
  }
})

test('defaultThemeArgs reads the tenant theme rather than assuming one exists', () => {
  assert.deepEqual(defaultThemeArgs(), ['api', 'get', 'branding/themes/default'])
})

test('isAuth0ApiNotFound selects create only for an explicit API 404', () => {
  assert.equal(isAuth0ApiNotFound({ stderr: 'Request failed with status code 404' }), true)
  assert.equal(isAuth0ApiNotFound({ stderr: 'HTTP/2 404' }), true)
  assert.equal(isAuth0ApiNotFound({ stderr: 'Request failed with status code 401' }), false)
  assert.equal(isAuth0ApiNotFound({ stderr: 'HTTP request failed; retry after 404 seconds' }), false)
  assert.equal(isAuth0ApiNotFound({ stderr: 'status unknown; body contained 404 bytes' }), false)
  assert.equal(isAuth0ApiNotFound({ stderr: 'dial tcp: network is unreachable' }), false)
  assert.equal(isAuth0ApiNotFound(new Error('unrelated failure')), false)
})

test('the checked-in Free-plan theme is the one bootstrap will actually send', () => {
  // Guards the hand-edited payload; a typo otherwise surfaces only against a
  // real tenant.
  const resolved = resolveAuth0BrandingAssets({
    theme: CHECKED_IN_THEME,
    stackDomain: 'dev.boxlite.example',
  })
  assert.doesNotThrow(() => brandingThemeArgs({ themeId: 'thm_1', theme: resolved.theme }))
  assert.equal(CHECKED_IN_THEME.borders.button_border_radius, 1)
  assert.equal(CHECKED_IN_THEME.borders.input_border_radius, 1)
  assert.equal(CHECKED_IN_THEME.borders.widget_corner_radius, 1)
  assert.equal(CHECKED_IN_THEME.fonts.reference_text_size, 13)
  assert.equal('page_background' in CHECKED_IN_THEME.colors, false)
  assert.equal(CHECKED_IN_THEME.colors.read_only_background, '#232833')
  assert.equal(CHECKED_IN_THEME.page_background.background_image_url, '')
  assert.equal(CHECKED_IN_THEME.widget.social_buttons_layout, 'top')
})

test('customTextRequests emits one PUT per prompt, keyed by screen', () => {
  const requests = customTextRequests({
    language: 'en',
    prompts: { login: { login: { description: 'x' } }, signup: { signup: { description: 'x' } } },
  })
  assert.deepEqual(
    requests.map((args) => args[2]),
    ['prompts/login/custom-text/en', 'prompts/signup/custom-text/en'],
  )
  assert.deepEqual(JSON.parse(valueAfter(requests[0], '--data')), { login: { description: 'x' } })
})

test('customTextArgs refuses an override with nothing left to send', () => {
  // The endpoint REPLACES the prompt's document, so shipping an empty body
  // would silently wipe the copy rather than leave it alone.
  assert.throws(() => customTextArgs({ prompt: 'login', language: 'en', text: {} }), /is empty/)
  assert.throws(() => customTextArgs({ prompt: 'login', language: 'en', text: { _comment: 'note' } }), /is empty/)
  assert.throws(() => customTextArgs({ prompt: 'login', text: { login: {} } }), /needs both a prompt and a language/)
  assert.throws(() => customTextArgs({ prompt: 'login', language: 'en', text: { login: {} } }), /invalid 'login' screen/)
  assert.throws(
    () => customTextArgs({ prompt: 'login', language: 'en', text: { login: { title: 42 } } }),
    /invalid text 'login.title'/,
  )
  assert.throws(
    () => customTextArgs({ prompt: 'login', language: 'en', text: { login: { title: '  ' } } }),
    /invalid text 'login.title'/,
  )
})

test('customTextRequests rejects malformed documents instead of silently applying nothing', () => {
  assert.throws(() => customTextRequests({ language: '', prompts: { login: { login: {} } } }), /language/)
  assert.throws(() => customTextRequests({ language: 'en', prompts: [] }), /prompts/)
  assert.throws(() => customTextRequests({ language: 'en', prompts: {} }), /prompts/)
  assert.throws(() => customTextRequests({ language: 'en', prompts: { login: 'not an object' } }), /login/)
  assert.throws(() => customTextRequests({ language: 'en', prompts: { _comment: 'metadata only' } }), /prompts/)
})

test('prepareAuth0Branding validates every payload before returning a write plan', () => {
  assert.throws(
    () =>
      prepareAuth0Branding({
        theme: { widget: { logo_url: 'https://assets.example.com/logo.png' } },
        customText: CHECKED_IN_TEXT,
      }),
    /colors and fonts/,
  )
  assert.throws(
    () =>
      prepareAuth0Branding({
        theme: theme(),
        customText: { language: 'en', prompts: {} },
      }),
    /prompts/,
  )
  const plan = prepareAuth0Branding({
    theme: RESOLVED_CHECKED_IN.theme,
    customText: CHECKED_IN_TEXT,
  })
  assert.equal(plan.customTextArgs.length, 2)
  assert.equal(plan.assetUrls.length, 2)
})

test('the checked-in copy shares a description but splits the titles', () => {
  // Auth0's two defaults differ ("Log in to …" / "Sign Up to …"), so overriding
  // one prompt and not the other leaves the screens reading differently.
  const requests = customTextRequests(CHECKED_IN_TEXT)
  assert.deepEqual(Object.keys(CHECKED_IN_TEXT.prompts), ['login', 'signup'])
  const login = JSON.parse(valueAfter(requests[0], '--data')).login
  const signup = JSON.parse(valueAfter(requests[1], '--data')).signup
  assert.equal(login.description, signup.description)

  // The titles diverging is the point, not an oversight: login is the
  // returning-user screen, and the product name belongs on the one where it is
  // the visitor's first contact rather than a repeat of the wordmark above it.
  assert.notEqual(login.title, signup.title)
  assert.doesNotMatch(login.title, /BoxLite/)
  assert.match(signup.title, /BoxLite/)
})
