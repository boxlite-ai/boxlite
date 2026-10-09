// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/**
 * Auth0 Post-Login Action for the BoxLite SPA.
 *
 * New database users are verified by Universal Login before a password is
 * created. Existing unverified database users are sent through the configured
 * Auth0 Form during an interactive browser login. Refresh-token, device-code,
 * and other non-browser exchanges cannot render Forms, so they fail closed.
 *
 * A social login is folded into the password account that already holds its
 * address before any token is issued (POL-555), without leaving Auth0: an
 * Auth0 Form asks for that account's password, the password-realm grant checks
 * it, the BoxLite API moves the folded user's data, and the Management API
 * links the identities so the token names the account that stays. An address
 * the provider has not verified is proven with the email Form first. With no
 * API origin or link Form configured the step is off, and social logins keep
 * their own identity.
 */

const BROWSER_PROTOCOLS = new Set(['oidc-basic-profile', 'oidc-hybrid-profile', 'oidc-implicit-profile'])
const BOXLITE_CLIENT_ID = __BOXLITE_CLIENT_ID_JSON__
const BOXLITE_DB_CONNECTION = __BOXLITE_DB_CONNECTION_JSON__
const EMAIL_VERIFICATION_FORM_ID = __EMAIL_VERIFICATION_FORM_ID_JSON__
// Where the BoxLite API is served, and the Form that asks for the proof.
// Either one empty turns the account link off.
const ACCOUNT_LINK_API_ORIGIN = __ACCOUNT_LINK_API_ORIGIN_JSON__
const ACCOUNT_LINK_FORM_ID = __ACCOUNT_LINK_FORM_ID_JSON__
// The tenant's own domain: its token endpoint and Management API answer there
// whichever domain the login itself runs on.
const AUTH0_DOMAIN = __AUTH0_DOMAIN_JSON__

// The API refuses an adopt request signed for any other audience.
const ADOPT_AUDIENCE = 'boxlite-account-link-adopt'
const PASSWORD_REALM_GRANT = 'http://auth0.com/oauth/grant-type/password-realm'

function isBoxLiteBrowserLogin(event) {
  return event.client?.client_id === BOXLITE_CLIENT_ID && BROWSER_PROTOCOLS.has(event.transaction?.protocol)
}

function isManagedDatabaseLogin(event) {
  return (
    event.client?.client_id === BOXLITE_CLIENT_ID &&
    event.connection?.strategy === 'auth0' &&
    event.connection?.name === BOXLITE_DB_CONNECTION
  )
}

/**
 * An interactive BoxLite browser login through a social connection whose user
 * has a single sign-in. A user already linked reaches its account directly, so
 * this stops matching once the link is made. A token refresh or other exchange
 * keeps the identity it has until the next browser login: it cannot show a
 * Form, and the Management API lookup would otherwise run on every refresh.
 */
function needsAccountLink(event) {
  return (
    Boolean(ACCOUNT_LINK_API_ORIGIN && ACCOUNT_LINK_FORM_ID && AUTH0_DOMAIN) &&
    isBoxLiteBrowserLogin(event) &&
    event.user?.identities?.length === 1 &&
    event.connection?.strategy !== 'auth0'
  )
}

function setIdentityClaims(event, api, emailVerified = event.user?.email_verified === true) {
  if (!event.authorization) return
  api.accessToken.setCustomClaim('email_verified', emailVerified)
  api.accessToken.setCustomClaim('email', event.user?.email)
  api.accessToken.setCustomClaim('name', event.user?.name)
}

async function tokenEndpoint(body, headers = {}) {
  return fetch(`https://${AUTH0_DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** A Management API token for the link client, cached for the tenant's other logins. */
async function managementToken(event, api) {
  const cached = api.cache.get('account-link-management-token')
  if (cached?.value) return cached.value
  const response = await tokenEndpoint({
    grant_type: 'client_credentials',
    client_id: event.secrets.ACCOUNT_LINK_CLIENT_ID,
    client_secret: event.secrets.ACCOUNT_LINK_CLIENT_SECRET,
    audience: `https://${AUTH0_DOMAIN}/api/v2/`,
  })
  if (!response.ok) throw new Error(`the Management API token request answered ${response.status}`)
  const { access_token: token, expires_in: expiresIn } = await response.json()
  // A minute short of its expiry, so no call starts with a token about to lapse.
  api.cache.set('account-link-management-token', token, { ttl: Math.max(expiresIn - 60, 1) * 1000 })
  return token
}

async function management(event, api, method, path, body) {
  const response = await fetch(`https://${AUTH0_DOMAIN}/api/v2${path}`, {
    method,
    headers: { authorization: `Bearer ${await managementToken(event, api)}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

/**
 * The other users holding this login's address with a verified email: the
 * accounts it may fold into. An unverified one is left alone, since a stranger
 * may have signed the address up. Auth0 matches addresses case-sensitively, so
 * the address is looked up as given and in lower case.
 */
async function otherAccounts(event, api) {
  const found = new Map()
  for (const address of new Set([event.user.email, event.user.email.toLowerCase()])) {
    const { status, body } = await management(event, api, 'GET', `/users-by-email?email=${encodeURIComponent(address)}`)
    if (status !== 200) throw new Error(`users-by-email answered ${status}`)
    for (const user of body) found.set(user.user_id, user)
  }
  found.delete(event.user.user_id)
  return [...found.values()].filter((user) => user.email_verified === true)
}

function holdsPassword(user) {
  return (user.identities ?? []).some((identity) => identity.connection === BOXLITE_DB_CONNECTION)
}

/** The link page, asking for the password of the account holding the address. */
function renderLinkForm(event, api, { error = '' } = {}) {
  api.prompt.render(ACCOUNT_LINK_FORM_ID, {
    vars: {
      email: event.user.email,
      lead: 'An account already uses this email. Enter its password to link them.',
      error,
    },
  })
}

/**
 * The password-realm grant, through the link client. The browser's address
 * rides in `auth0-forwarded-for`, which Auth0 honours because the link client
 * trusts that header, so brute-force protection counts attempts per person
 * rather than against the Action's shared addresses.
 */
async function checkPassword(event, password) {
  const response = await tokenEndpoint(
    {
      grant_type: PASSWORD_REALM_GRANT,
      client_id: event.secrets.ACCOUNT_LINK_CLIENT_ID,
      client_secret: event.secrets.ACCOUNT_LINK_CLIENT_SECRET,
      realm: BOXLITE_DB_CONNECTION,
      username: event.user.email.toLowerCase(),
      password,
      scope: 'openid',
    },
    { 'auth0-forwarded-for': event.request?.ip ?? '' },
  )
  const body = await response.json().catch(() => ({}))
  if (!response.ok) return { ok: false, error: body.error, message: body.error_description }
  return { ok: true, claims: idTokenClaims(event, body.id_token) }
}

/**
 * The ID token the grant returned. It came straight from the token endpoint
 * over TLS, so the signature needs no check (OIDC Core 3.1.3.7); the issuer,
 * audience and expiry still do.
 */
function idTokenClaims(event, idToken) {
  const claims = JSON.parse(Buffer.from(String(idToken).split('.')[1] ?? '', 'base64url').toString('utf8') || '{}')
  const valid =
    claims.iss === `https://${AUTH0_DOMAIN}/` &&
    claims.aud === event.secrets.ACCOUNT_LINK_CLIENT_ID &&
    typeof claims.exp === 'number' &&
    claims.exp * 1000 > Date.now()
  return valid ? claims : null
}

/** An HS256 token the API checks before it answers. */
function signLinkRequest(event, audience, claims) {
  const crypto = require('crypto')
  const now = Math.floor(Date.now() / 1000)
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ ...claims, aud: audience, iat: now, exp: now + 60 })}`
  const signature = crypto.createHmac('sha256', event.secrets.ACCOUNT_LINK_SECRET).update(unsigned).digest('base64url')
  return `${unsigned}.${signature}`
}

async function adopt(event, primaryUserId, userId) {
  const token = signLinkRequest(event, ADOPT_AUDIENCE, { sub: userId, primary_user_id: primaryUserId })
  const response = await fetch(`${ACCOUNT_LINK_API_ORIGIN}/api/auth/link/adopt`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  })
  if (response.status !== 204) throw new Error(`the BoxLite API answered ${response.status} to adopt`)
}

async function link(event, api, primaryUserId, userId) {
  const separator = userId.indexOf('|')
  const { status } = await management(event, api, 'POST', `/users/${encodeURIComponent(primaryUserId)}/identities`, {
    provider: userId.slice(0, separator),
    user_id: userId.slice(separator + 1),
  })
  if (status !== 201) throw new Error(`linking answered ${status}`)
}

/**
 * Folds this login into `account`, which stays, so the login makes no
 * organization of its own. Local data moves before the tenant link: once
 * linked, later logins reach the account directly and never pass here again,
 * so anything not yet moved would stay stranded, while a failed link is simply
 * retried at the next login.
 */
async function fold(event, api, account) {
  await adopt(event, account.user_id, event.user.user_id)
  await link(event, api, account.user_id, event.user.user_id)
  api.authentication.setPrimaryUser(account.user_id)
  setIdentityClaims(event, api, true)
}

/**
 * Shows the link page when a password account holds this login's address.
 * `mailboxProven` is set right after the email Form has checked a code.
 */
async function planLink(event, api, { mailboxProven = false } = {}) {
  const emailVerified = mailboxProven || event.user.email_verified === true
  let accounts
  try {
    accounts = await otherAccounts(event, api)
  } catch (error) {
    // A throttled or unreachable Management API must not lock logins out:
    // this one goes through unlinked, and the next one looks again.
    console.log(`Account link lookup failed, continuing unlinked: ${error?.message ?? error}`)
    setIdentityClaims(event, api, emailVerified)
    return
  }
  // With no password to ask for, only social accounts or none, this login
  // goes on as it is.
  if (!accounts.some(holdsPassword)) {
    setIdentityClaims(event, api, emailVerified)
    return
  }
  renderLinkForm(event, api)
}

async function startAccountLink(event, api) {
  // Without an address there is no account to fold into.
  if (!event.user?.email) {
    setIdentityClaims(event, api)
    return
  }
  // An address only the provider vouches for is proven with the email Form
  // first, as an unverified password account's is.
  if (event.user.email_verified !== true) {
    if (!EMAIL_VERIFICATION_FORM_ID) {
      api.access.deny('Email verification is unavailable')
      return
    }
    api.prompt.render(EMAIL_VERIFICATION_FORM_ID)
    return
  }
  await planLink(event, api)
}

/** The link page came back with the password, or without one. */
async function answerLinkForm(event, api) {
  const passwordAccount = (await otherAccounts(event, api)).find(holdsPassword)
  if (!passwordAccount) {
    setIdentityClaims(event, api)
    return
  }
  const password = event.prompt?.fields?.password
  if (typeof password !== 'string' || password === '') {
    renderLinkForm(event, api, { error: 'Enter the password.' })
    return
  }
  if (!(await provePassword(event, api, passwordAccount, password))) return
  await fold(event, api, passwordAccount)
}

/** True once the account's password checks out; otherwise the page or a denial has answered. */
async function provePassword(event, api, account, password) {
  const check = await checkPassword(event, password)
  if (check.ok && check.claims?.sub !== account.user_id) {
    console.log('Account link password check returned no valid ID token for that account')
    api.access.deny('Account linking failed')
    return false
  }
  if (!check.ok) {
    if (check.error === 'invalid_grant') {
      renderLinkForm(event, api, { error: 'That password is not right. Try again.' })
      return false
    }
    console.log(`Account link password check refused: ${check.error}`)
    api.access.deny(
      check.error === 'mfa_required'
        ? 'This account uses multi-factor authentication, which account linking does not support yet'
        : check.message || 'Account linking failed',
    )
    return false
  }
  return true
}

/** Any failure to reach Auth0 or BoxLite ends the login; the next one retries. */
async function withAccountLink(api, step) {
  try {
    await step()
  } catch (error) {
    console.log(`Account link failed: ${error?.message ?? error}`)
    api.access.deny('Account linking is unavailable right now. Try again in a moment.')
  }
}

exports.onExecutePostLogin = async (event, api) => {
  if (needsAccountLink(event)) {
    await withAccountLink(api, () => startAccountLink(event, api))
    return
  }

  if (!isManagedDatabaseLogin(event)) {
    setIdentityClaims(event, api)
    return
  }

  if (event.user?.email_verified === true) {
    setIdentityClaims(event, api, true)
    return
  }

  const formId = EMAIL_VERIFICATION_FORM_ID
  if (!event.user?.email || !formId) {
    api.access.deny('Email verification is unavailable')
    return
  }

  if (BROWSER_PROTOCOLS.has(event.transaction?.protocol)) {
    api.prompt.render(formId)
    return
  }

  api.access.deny('Email verification required; sign in through a browser')
}

exports.onContinuePostLogin = async (event, api) => {
  const formId = EMAIL_VERIFICATION_FORM_ID

  if (needsAccountLink(event)) {
    if (event.prompt?.id === ACCOUNT_LINK_FORM_ID) {
      await withAccountLink(api, () => answerLinkForm(event, api))
      return
    }
    // Back from the email Form: its code proved the address.
    if (formId && event.prompt?.id === formId) {
      await withAccountLink(api, () => planLink(event, api, { mailboxProven: true }))
      return
    }
    api.access.deny('Account linking failed')
    return
  }

  if (!isManagedDatabaseLogin(event) || !formId || event.prompt?.id !== formId) {
    api.access.deny('Email verification failed')
    return
  }

  // The Form resumes only after its verify-OTP flow updates the root Auth0
  // profile. The Action event can still contain the pre-Form user snapshot, so
  // this exact continuation is the point at which the token claim turns true.
  setIdentityClaims(event, api, true)
}
