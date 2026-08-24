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
 * Unlike application and API provisioning, these writes are idempotent: the
 * theme is patched (or created once) and custom text is replaced per prompt.
 * Bootstrap keeps them behind their own flag so iterating on appearance never
 * re-creates an application.
 *
 * This path deliberately uses only APIs available on Auth0's Free plan. The
 * Branding Theme API cannot express spacing, control height, widget width,
 * line-height or letter-spacing; those values therefore remain Auth0 defaults.
 * A Universal Login page template could override them, but Auth0 reserves that
 * endpoint for paid plans and rejects it with 402 on Free, so including it
 * would make every apply partially update the theme before failing.
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

const STACK_DOMAIN_TOKEN = '__BOXLITE_STACK_DOMAIN__'

function replaceStackDomain(value: any, stackDomain: string): any {
  if (Array.isArray(value)) return value.map((nested) => replaceStackDomain(nested, stackDomain))
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? value.replaceAll(STACK_DOMAIN_TOKEN, stackDomain) : value
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, replaceStackDomain(nested, stackDomain)]),
  )
}

/** Resolves stage-owned asset URLs before any payload validation or network I/O. */
export function resolveAuth0BrandingAssets({ theme, stackDomain }: any) {
  requireHostname('stackDomain', stackDomain)
  return { theme: replaceStackDomain(theme, stackDomain) }
}

/*
 * The repo vouches for the source bytes, but not for the selected stage having
 * deployed them yet. An unpublished file produces no error from Auth0 at all —
 * the browser simply falls back, so the most visible half of the restyle does
 * not happen and the run still reports success. Requiring an absolute https
 * URL catches the shape here; bootstrap checks the deployed response.
 */
function requireAssetUrl(name: any, value: any) {
  if (typeof value !== 'string' || !value.startsWith('https://') || value.includes(STACK_DOMAIN_TOKEN)) {
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
  contentType,
  allowOrigin,
  auth0Origin,
}: {
  url: string
  status: number
  bodyLength: number
  contentType: string | null
  allowOrigin: string | null
  auth0Origin: string
}) {
  validatePublishedAssetMetadata({ url, status, contentType, allowOrigin, auth0Origin })
  validatePublishedAssetBody({ url, bodyLength })
}

const ASSET_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

function expectedAssetContentType(url: string) {
  const pathname = new URL(url).pathname.toLowerCase()
  const extension = Object.keys(ASSET_CONTENT_TYPES).find((candidate) => pathname.endsWith(candidate))
  if (!extension) throw new Error(`the Universal Login asset ${url} has an unsupported file extension`)
  return ASSET_CONTENT_TYPES[extension]
}

export function validatePublishedAssetMetadata({
  url,
  status,
  contentType,
  allowOrigin,
  auth0Origin,
}: {
  url: string
  status: number
  contentType: string | null
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
  const expectedContentType = expectedAssetContentType(url)
  const mediaType = contentType?.split(';', 1)[0].trim().toLowerCase()
  if (mediaType !== expectedContentType) {
    throw new Error(
      `the Universal Login asset ${url} returned Content-Type '${contentType ?? '<missing>'}', ` +
        `expected '${expectedContentType}'. A SPA fallback can return HTML with status 200 while the asset is missing.`,
    )
  }
  if (allowOrigin !== '*' && allowOrigin !== auth0Origin) {
    throw new Error(
      `the Universal Login asset ${url} returned Access-Control-Allow-Origin '${allowOrigin ?? '<missing>'}', ` +
        `expected '*' or '${auth0Origin}'. Auth0 can store the theme URL, but the browser will refuse to load the asset.`,
    )
  }
}

export function validatePublishedAssetBody({ url, bodyLength }: { url: string; bodyLength: number }) {
  if (bodyLength <= 0) {
    throw new Error(`the Universal Login asset ${url} returned an empty body`)
  }
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

/** Validates every checked-in branding payload before the caller performs its first write. */
export function prepareAuth0Branding({ theme, customText }: any) {
  brandingThemeArgs({ themeId: 'preflight', theme })
  const assetUrls = [...new Set(themeAssetUrls(theme))]
  const customTextArgs = customTextRequests(customText)
  return { theme, assetUrls, customTextArgs }
}
