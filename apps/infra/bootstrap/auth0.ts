// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Pure argument/payload construction for provisioning an Auth0 tenant through
 * the `auth0` CLI, replacing the manual dashboard steps a fresh tenant would
 * otherwise need. Reached through `npm run bootstrap -- --provision-auth0`.
 *
 * The device-code token minted by `auth0 login` already carries the scopes all
 * of this needs (create:clients, create:resource_servers, create:actions,
 * update:actions, update:tenant_settings), so there is no
 * create-an-M2M-app-first chicken-and-egg.
 *
 * Two operations have no first-class CLI verb and go through `auth0 api`, the
 * raw Management API passthrough:
 *   - binding a deployed Action to the post-login flow (`auth0 actions deploy`
 *     explicitly does NOT bind: "Before an action can be bound to a flow, the
 *     action must be deployed")
 *   - flipping the tenant's RP-initiated-logout discovery setting
 *
 * Creating the tenant itself has no Management API and stays manual.
 */

const LOOPBACK_CALLBACK = 'http://127.0.0.1:5555/callback'

function requireHostname(name: any, value: any) {
  if (!value || value !== value.trim() || value.includes('/')) {
    throw new Error(`${name} '${value}' must be a bare hostname`)
  }
  return value
}

/*
 * Callback URLs must cover both front ends that complete an OIDC redirect:
 * the dashboard SPA, and the Rust CLI's `auth login --method browser`, which
 * RFC 8252 §8.3 requires to use the IPv4 loopback literal rather than
 * `localhost`.
 */
export function spaApplicationArgs({ stackDomain, name = 'boxlite-dashboard' }: any) {
  requireHostname('stackDomain', stackDomain)
  const dashboardUrl = `https://${stackDomain}`
  return [
    'apps',
    'create',
    '--name',
    name,
    '--type',
    'spa',
    '--callbacks',
    `${dashboardUrl},${LOOPBACK_CALLBACK}`,
    '--logout-urls',
    dashboardUrl,
    '--json',
  ]
}

// The API identifier becomes OIDC_AUDIENCE verbatim; it is an opaque
// identifier to Auth0, not a URL it ever dereferences.
export function customApiArgs({ stackDomain, name = 'boxlite-api' }: any) {
  requireHostname('stackDomain', stackDomain)
  return ['apis', 'create', '--name', name, '--identifier', `https://${stackDomain}/api`, '--json']
}

export function createActionArgs({ code, name = 'boxlite-custom-claims', runtime = 'node18' }: any) {
  if (!code || !code.trim()) throw new Error('the post-login Action body is required')
  return ['actions', 'create', '--name', name, '--trigger', 'post-login', '--runtime', runtime, '--code', code, '--json']
}

export function deployActionArgs(actionId: any) {
  if (!actionId) throw new Error('actionId is required to deploy an Action')
  return ['actions', 'deploy', actionId]
}

/*
 * PATCH /api/v2/actions/triggers/post-login/bindings replaces the whole
 * binding list, so callers must pass every binding they intend to keep — a
 * bare single-entry payload silently unbinds anything else already on the
 * flow.
 */
interface ExistingActionBinding {
  action?: { id?: string }
  display_name?: string
}

export function bindActionArgs({ actionId, displayName = 'boxlite-custom-claims', existingBindings = [] }: {
  actionId: string
  displayName?: string
  existingBindings?: ExistingActionBinding[]
}) {
  if (!actionId) throw new Error('actionId is required to bind an Action')
  // Require action.id in the filter, not just a mismatch: a binding without an
  // `action` object passes an inequality test and then throws in the map. A
  // binding whose Action has been deleted is the shape to expect, and losing
  // the whole rebind to one of those is worse than dropping it.
  const preserved = existingBindings
    .filter(
      (binding): binding is ExistingActionBinding & { action: { id: string } } =>
        Boolean(binding?.action?.id && binding.action.id !== actionId && binding.display_name !== displayName),
    )
    .map((binding) => ({
      ref: { type: 'action_id', value: binding.action.id },
      display_name: binding.display_name,
    }))

  const bindings = [...preserved, { ref: { type: 'action_id', value: actionId }, display_name: displayName }]
  return ['api', 'patch', 'actions/triggers/post-login/bindings', '--data', JSON.stringify({ bindings })]
}

// Without this the dashboard's "Sign out" only clears BoxLite's own session:
// the still-live Auth0 cookie silently re-authenticates and logout looks like
// a page refresh.
export function enableRpLogoutDiscoveryArgs() {
  return [
    'api',
    'patch',
    'tenants/settings',
    '--data',
    JSON.stringify({ oidc_logout: { rp_logout_end_session_endpoint_discovery: true } }),
  ]
}

/*
 * ---------------------------------------------------------------------------
 * Universal Login branding
 *
 * Unlike everything above, these are idempotent: the theme is a PATCH and the
 * page template a PUT, so re-running overwrites rather than duplicates. That
 * is why bootstrap exposes them under their own flag instead of folding them
 * into --provision-auth0 — the login page's appearance gets iterated on, and
 * nobody should have to re-create an application to change a border radius.
 *
 * The split between the two payloads is not stylistic. The Branding Theme API
 * has no field for spacing, control height, widget width, line-height or
 * letter-spacing, and its reference_text_size only reaches the selectors that
 * consume --default-font-size — which buttons, social buttons and labels do
 * not. Those gaps can only be closed by CSS, and CSS can only reach the page
 * through a page template, which in turn requires the custom domain the
 * deployment already has. Hence: colors/radii/fonts in the theme, everything
 * the theme cannot express in the template.
 */

/*
 * The checked-in payloads carry `_comment` keys explaining non-obvious values
 * to the next reader. The Management API rejects unknown fields, so they are
 * stripped on the way out rather than being kept in a separate doc that would
 * drift from the values it describes.
 */
function withoutComments(value: any): any {
  if (Array.isArray(value)) return value.map(withoutComments)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !key.startsWith('_'))
      .map(([key, nested]) => [key, withoutComments(nested)]),
  )
}

/*
 * Remote assets are the one part of this the repo cannot vouch for: the logo
 * and the fonts live on a static host, and an unpublished file produces no
 * error from Auth0 at all — the browser simply falls back, so the most visible
 * half of the restyle does not happen and the run still reports success.
 * Requiring an absolute https URL catches the shape here; bootstrap checks
 * that the files actually resolve.
 */
function requireAssetUrl(name: any, value: any) {
  if (typeof value !== 'string' || !value.startsWith('https://')) {
    throw new Error(`${name} must be an absolute https URL, got '${value}'`)
  }
  return value
}

/** Remote assets the theme depends on, for bootstrap to probe. */
export function themeAssetUrls(theme: any) {
  const urls = [requireAssetUrl('widget.logo_url', theme?.widget?.logo_url)]
  if (theme?.fonts?.font_url !== undefined) {
    urls.push(requireAssetUrl('fonts.font_url', theme.fonts.font_url))
  }
  return urls
}

export function validatePublishedAssetResponse({
  url,
  status,
  bodyLength,
  allowOrigin,
  auth0Origin,
}: {
  url: string
  status: number
  bodyLength: number
  allowOrigin: string | null
  auth0Origin: string
}) {
  validatePublishedAssetMetadata({ url, status, allowOrigin, auth0Origin })
  validatePublishedAssetBody({ url, bodyLength })
}

export function validatePublishedAssetMetadata({
  url,
  status,
  allowOrigin,
  auth0Origin,
}: {
  url: string
  status: number
  allowOrigin: string | null
  auth0Origin: string
}) {
  if (status !== 200) {
    throw new Error(
      `the Universal Login asset ${url} returned ${status}. ` +
        'Publish it to the configured asset host before applying branding — ' +
        'Auth0 accepts an unreachable asset without complaint and the login page just keeps its default appearance.',
    )
  }
  if (allowOrigin !== '*' && allowOrigin !== auth0Origin) {
    throw new Error(
      `the Universal Login asset ${url} returned Access-Control-Allow-Origin '${allowOrigin ?? '<missing>'}', ` +
        `expected '*' or '${auth0Origin}'. Auth0 can store the template, but the browser will refuse to load the asset.`,
    )
  }
}

export function validatePublishedAssetBody({ url, bodyLength }: { url: string; bodyLength: number }) {
  if (bodyLength <= 0) {
    throw new Error(`the Universal Login asset ${url} returned an empty body`)
  }
}

/*
 * The theme carries the regular face as the no-template fallback. Paid-plan
 * tenants also load both real weights from the template's @font-face rules;
 * font_url accepts only one URL, and IBM Plex Mono ships no variable face.
 * Reading the template URLs back out keeps those extra assets in the same
 * pre-write validation set as the theme fallback.
 */
const TEMPLATE_ASSET_PATTERN = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")][^)]*))\s*\)/gi

export function templateAssetUrls(template: any) {
  return [...String(template ?? '').matchAll(TEMPLATE_ASSET_PATTERN)].map((match, index) =>
    requireAssetUrl(`template asset URL ${index + 1}`, (match[1] ?? match[2] ?? match[3]).trim()),
  )
}

/**
 * Read the tenant's current theme. Auth0 creates no theme until one is set, so
 * this 404s on a fresh tenant — the caller decides between PATCH and POST on
 * that basis, the same read-then-write shape the Action binding needs.
 */
export function defaultThemeArgs() {
  return ['api', 'get', 'branding/themes/default']
}

export function isAuth0ApiNotFound(cause: any) {
  const stderr = typeof cause?.stderr === 'string' ? cause.stderr : cause?.stderr?.toString?.()
  return (
    typeof stderr === 'string' &&
    /(?:status(?: code)?\s*[:=]?\s*404\b|HTTP(?:\/\d(?:\.\d)?)?\s+404\b|\b404 Not Found\b)/i.test(stderr)
  )
}

export function brandingThemeArgs({ themeId, theme }: any) {
  if (!theme?.colors || !theme?.fonts) {
    throw new Error('the branding theme payload needs at least colors and fonts')
  }
  themeAssetUrls(theme)
  const data = JSON.stringify(withoutComments(theme))
  return themeId
    ? ['api', 'patch', `branding/themes/${themeId}`, '--data', data]
    : ['api', 'post', 'branding/themes', '--data', data]
}

/*
 * Auth0 requires both markers and rejects the template without them. That
 * rejection arrives as an opaque 400 from the API, so the check is worth
 * having here where the message can name what is missing.
 */
const REQUIRED_TEMPLATE_MARKERS = ['{%- auth0:head -%}', '{%- auth0:widget -%}']

/*
 * One PUT per prompt. The endpoint replaces that prompt's whole custom-text
 * document for the language, so a payload must carry every key it means to
 * keep — the same replace-not-merge shape as the Action bindings above.
 */
export function customTextArgs({ prompt, language, text }: any) {
  if (typeof prompt !== 'string' || !prompt.trim() || typeof language !== 'string' || !language.trim()) {
    throw new Error('a custom-text override needs both a prompt and a language')
  }
  const body = withoutComments(text)
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length === 0) {
    throw new Error(`the custom-text override for prompt '${prompt}' is empty`)
  }
  for (const [screen, screenText] of Object.entries(body)) {
    if (
      !screen.trim() ||
      !screenText ||
      typeof screenText !== 'object' ||
      Array.isArray(screenText) ||
      Object.keys(screenText).length === 0
    ) {
      throw new Error(`the custom-text override for prompt '${prompt}' has an invalid '${screen}' screen`)
    }
    for (const [key, value] of Object.entries(screenText)) {
      if (!key.trim() || typeof value !== 'string' || !value.trim()) {
        throw new Error(`the custom-text override for prompt '${prompt}' has invalid text '${screen}.${key}'`)
      }
    }
  }
  return ['api', 'put', `prompts/${prompt}/custom-text/${language}`, '--data', JSON.stringify(body)]
}

/** Flattens the checked-in document into one argv per prompt. */
export function customTextRequests(document: any) {
  const language = document?.language
  if (typeof language !== 'string' || !language.trim()) {
    throw new Error('the custom-text document needs a non-empty language')
  }
  const prompts = withoutComments(document?.prompts)
  if (!prompts || typeof prompts !== 'object' || Array.isArray(prompts) || Object.keys(prompts).length === 0) {
    throw new Error('the custom-text document needs a non-empty prompts object')
  }
  return Object.entries(prompts).map(([prompt, text]) => customTextArgs({ prompt, language, text }))
}

export function pageTemplateArgs(template: any) {
  const missing = REQUIRED_TEMPLATE_MARKERS.filter((marker) => !template?.includes(marker))
  if (missing.length > 0) {
    throw new Error(`the page template is missing required marker(s): ${missing.join(', ')}`)
  }
  return ['api', 'put', 'branding/templates/universal-login', '--data', JSON.stringify({ template })]
}

/** Validates every checked-in branding payload before the caller performs its first write. */
export function prepareAuth0Branding({ theme, template, customText }: any) {
  brandingThemeArgs({ themeId: 'preflight', theme })
  const assetUrls = [...new Set([...themeAssetUrls(theme), ...templateAssetUrls(template)])]
  const templateArgs = pageTemplateArgs(template)
  const customTextArgs = customTextRequests(customText)
  return { theme, assetUrls, templateArgs, customTextArgs }
}
