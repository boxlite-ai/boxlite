// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type JsonObject, parseTarget, prepareTheme } from '../auth0/universal-login.js'

const bootstrapRoot = dirname(fileURLToPath(import.meta.url))
const auth0Root = join(bootstrapRoot, '..', 'auth0')

/**
 * The login page's font and logo for `tenant`, as Universal Login resolves them
 * for the stage that names it (auth0/targets.json, auth0/branding/theme.json):
 * absolute URLs on that stage's origin, the font only when the theme sets one.
 * A tenant no stage names gets neither, and the Form keeps Auth0's defaults.
 */
function loginPageAssets(tenant: string) {
  const targets = JSON.parse(readFileSync(join(auth0Root, 'targets.json'), 'utf8')) as JsonObject
  const stage = Object.keys(targets).find((name) => (targets[name] as JsonObject)?.auth0TenantDomain === tenant)
  if (!stage) return { fontUrl: null, logoUrl: null }
  const theme = prepareTheme(
    JSON.parse(readFileSync(join(auth0Root, 'branding', 'theme.json'), 'utf8')) as JsonObject,
    parseTarget(targets, stage),
  )
  const fontUrl = (theme.fonts as JsonObject).font_url
  return {
    fontUrl: typeof fontUrl === 'string' ? fontUrl : null,
    logoUrl: (theme.widget as JsonObject).logo_url as string,
  }
}

/**
 * The account link Form for `tenant` with its custom fields' code read in:
 * each CUSTOM component names a file in `auth0/account-link-form/`, and the
 * page's styles, font and logo fill the placeholders in the field that adds
 * them.
 */
export function loadAccountLinkForm(tenant: string) {
  const directory = join(bootstrapRoot, 'auth0', 'account-link-form')
  const form = JSON.parse(readFileSync(join(bootstrapRoot, 'auth0', 'account-link-form.json'), 'utf8'))
  const { fontUrl, logoUrl } = loginPageAssets(tenant)
  const placeholders: Record<string, string> = {
    __LINK_FORM_CSS_JSON__: JSON.stringify(readFileSync(join(directory, 'link-form.css'), 'utf8')),
    __LINK_FONT_URL_JSON__: JSON.stringify(fontUrl),
    __LINK_LOGO_URL_JSON__: JSON.stringify(logoUrl),
  }
  for (const node of form.nodes) {
    for (const component of node.config?.components ?? []) {
      if (component.type !== 'CUSTOM') continue
      let code = readFileSync(join(directory, component.config.code), 'utf8')
      for (const [placeholder, value] of Object.entries(placeholders)) code = code.replace(placeholder, () => value)
      component.config.code = code
    }
  }
  return form
}
