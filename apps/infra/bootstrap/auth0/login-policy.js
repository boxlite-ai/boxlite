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
 * A social login is linked into the password account holding its address, or
 * into a new one, before any token is issued (POL-555), without leaving
 * Auth0: an Auth0 Form asks for that account's password (or a new one, or a
 * reset email), the password-realm grant checks it (or the Management API
 * creates the account), the BoxLite API moves the social user's data, and the
 * Management API links the identities so the token names the password
 * account. An address the provider has not verified is proven with the email
 * Form first. With no API origin or link Form configured the step is off, and
 * social logins keep their own identity.
 */

const BROWSER_PROTOCOLS = new Set(['oidc-basic-profile', 'oidc-hybrid-profile', 'oidc-implicit-profile'])
const BOXLITE_CLIENT_ID = __BOXLITE_CLIENT_ID_JSON__
const BOXLITE_DB_CONNECTION = __BOXLITE_DB_CONNECTION_JSON__
const EMAIL_VERIFICATION_FORM_ID = __EMAIL_VERIFICATION_FORM_ID_JSON__
// Where the BoxLite API is served, and the Form that asks for the password.
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
 * An interactive BoxLite browser login through anything but the database
 * connection, whose user is not a password account yet. Once linked, Auth0
 * answers the same social login with the password account's `auth0|` user, so
 * this stops matching by itself. A token refresh or other exchange keeps the
 * identity it has until the next browser login: it cannot show a Form, and the
 * Management API lookup would otherwise run on every refresh.
 */
function needsAccountLink(event) {
  return (
    Boolean(ACCOUNT_LINK_API_ORIGIN && ACCOUNT_LINK_FORM_ID && AUTH0_DOMAIN) &&
    isBoxLiteBrowserLogin(event) &&
    event.connection?.strategy !== 'auth0' &&
    !String(event.user?.user_id ?? '').startsWith('auth0|')
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

/** The database account that holds this login's address, or null. */
async function findPasswordAccount(event, api) {
  const email = encodeURIComponent(event.user.email.toLowerCase())
  const { status, body } = await management(event, api, 'GET', `/users-by-email?email=${email}`)
  if (status !== 200) throw new Error(`users-by-email answered ${status}`)
  return (
    body.find(
      (user) =>
        String(user.user_id).startsWith('auth0|') &&
        user.identities?.some((identity) => identity.connection === BOXLITE_DB_CONNECTION),
    ) ?? null
  )
}

function renderLinkForm(event, api, { signUp = false, error = '' } = {}) {
  api.prompt.render(ACCOUNT_LINK_FORM_ID, {
    vars: {
      email: event.user.email,
      lead: signUp
        ? 'BoxLite accounts sign in with a password. Choose one for this address, and this sign-in will be linked to the new account.'
        : 'This address already has a BoxLite account. Enter its password to link this sign-in to it.',
      error,
    },
  })
}

/**
 * A password account for an address no database account holds yet, created
 * with the link client's `create:users` grant on the Management API. The
 * social provider or the email Form has proven the address, so it starts
 * verified; a password the connection's policy refuses comes back as the
 * reason to show.
 */
async function signUp(event, api, password) {
  const { status, body } = await management(event, api, 'POST', '/users', {
    connection: BOXLITE_DB_CONNECTION,
    email: event.user.email.toLowerCase(),
    password,
    email_verified: true,
  })
  if (status === 201) return { userId: body.user_id }
  // The connection's password policy answers 400 with a PasswordStrengthError,
  // PasswordDictionaryError and the like; any other 400 is not the person's to fix.
  const message = String(body?.message ?? '')
  if (status === 400 && /^Password\w*Error\b/.test(message)) {
    return { refused: `Choose another password: ${message.replace(/^Password\w*Error:\s*/, '')}` }
  }
  // Another login signed the address up first: link to that account instead.
  if (status === 409) return { taken: true }
  return { failed: `creating the password account answered ${status}: ${message}` }
}

/**
 * Auth0 emails the address a link to reset the password account's password,
 * on behalf of the BoxLite app, so the email and the page after it are the
 * app's rather than the link client's.
 */
async function sendPasswordReset(event) {
  const response = await fetch(`https://${AUTH0_DOMAIN}/dbconnections/change_password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_id: BOXLITE_CLIENT_ID,
      email: event.user.email.toLowerCase(),
      connection: BOXLITE_DB_CONNECTION,
    }),
  })
  if (!response.ok) throw new Error(`the password reset request answered ${response.status}`)
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

/** An HS256 token the API checks before it moves anything. */
function signAdoptRequest(event, primaryUserId) {
  const crypto = require('crypto')
  const now = Math.floor(Date.now() / 1000)
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const claims = {
    sub: event.user.user_id,
    primary_user_id: primaryUserId,
    aud: ADOPT_AUDIENCE,
    iat: now,
    exp: now + 60,
  }
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(claims)}`
  const signature = crypto.createHmac('sha256', event.secrets.ACCOUNT_LINK_SECRET).update(unsigned).digest('base64url')
  return `${unsigned}.${signature}`
}

async function linkIdentity(event, api, primaryUserId) {
  const separator = event.user.user_id.indexOf('|')
  const { status } = await management(event, api, 'POST', `/users/${encodeURIComponent(primaryUserId)}/identities`, {
    provider: event.user.user_id.slice(0, separator),
    user_id: event.user.user_id.slice(separator + 1),
  })
  if (status !== 201) throw new Error(`linking answered ${status}`)
}

async function startAccountLink(event, api) {
  // Without an address there is no password account to link to or create.
  if (!event.user?.email) {
    setIdentityClaims(event, api)
    return
  }
  // An address only the provider vouches for is not proof enough to be handed
  // a password account, so it is proven the same way a new sign-up is.
  if (event.user.email_verified !== true) {
    if (!EMAIL_VERIFICATION_FORM_ID) {
      api.access.deny('Email verification is unavailable')
      return
    }
    api.prompt.render(EMAIL_VERIFICATION_FORM_ID)
    return
  }
  await offerLinkForm(event, api)
}

/** The link Form, asking for the password account's password or for a new one. */
async function offerLinkForm(event, api) {
  let account
  try {
    account = await findPasswordAccount(event, api)
  } catch (error) {
    // A throttled or unreachable Management API must not lock social logins
    // out: this one goes through unlinked, and the next one looks again.
    console.log(`Account link lookup failed, continuing unlinked: ${error?.message ?? error}`)
    setIdentityClaims(event, api)
    return
  }
  renderLinkForm(event, api, { signUp: !account })
}

/**
 * The Form came back with a password, or with the reset box ticked. Local
 * data moves before the tenant link: once linked, later social logins reach
 * the password account directly and never pass here again, so anything not
 * yet moved would stay stranded, while a failed link is simply retried at the
 * next login.
 */
async function finishAccountLink(event, api) {
  const account = await findPasswordAccount(event, api)
  if (account && event.prompt?.fields?.reset === true) {
    await sendPasswordReset(event)
    api.access.deny(`We emailed ${event.user.email} a link to reset the password. Set a new one, then sign in again.`)
    return
  }
  const password = event.prompt?.fields?.password
  if (typeof password !== 'string' || password === '') {
    renderLinkForm(event, api, { signUp: !account, error: 'Enter the password.' })
    return
  }
  const primaryUserId = account
    ? await provePassword(event, api, account, password)
    : await createPasswordAccount(event, api, password)
  if (!primaryUserId) return
  const adopted = await fetch(`${ACCOUNT_LINK_API_ORIGIN}/api/auth/link/adopt`, {
    method: 'POST',
    headers: { authorization: `Bearer ${signAdoptRequest(event, primaryUserId)}` },
  })
  if (adopted.status !== 204) throw new Error(`the BoxLite API answered ${adopted.status} to adopt`)
  await linkIdentity(event, api, primaryUserId)
  api.authentication.setPrimaryUser(primaryUserId)
  setIdentityClaims(event, api, true)
}

/** The account's id once its password checks out; otherwise the Form or a denial has answered. */
async function provePassword(event, api, account, password) {
  const check = await checkPassword(event, password)
  if (check.ok && check.claims?.sub !== account.user_id) {
    console.log('Account link password check returned an ID token for another account')
    api.access.deny('Account linking failed')
    return null
  }
  if (!check.ok) {
    if (check.error === 'invalid_grant') {
      renderLinkForm(event, api, { error: 'That password is not right. Try again.' })
      return null
    }
    console.log(`Account link password check refused: ${check.error}`)
    api.access.deny(
      check.error === 'mfa_required'
        ? 'This account uses multi-factor authentication, which account linking does not support yet'
        : check.message || 'Account linking failed',
    )
    return null
  }
  // The social provider or the email Form proved the address already.
  if (account.email_verified !== true) {
    const path = `/users/${encodeURIComponent(account.user_id)}`
    const { status } = await management(event, api, 'PATCH', path, { email_verified: true })
    if (status !== 200) throw new Error(`marking the address verified answered ${status}`)
  }
  return account.user_id
}

/** The new account's id; otherwise the Form has asked again. */
async function createPasswordAccount(event, api, password) {
  const created = await signUp(event, api, password)
  if (created.failed) {
    // No other password would fix it: this login goes through unlinked, and
    // the next one tries again.
    console.log(`Account link sign-up failed, continuing unlinked: ${created.failed}`)
    setIdentityClaims(event, api)
    return null
  }
  if (created.refused) renderLinkForm(event, api, { signUp: true, error: created.refused })
  if (created.taken) {
    renderLinkForm(event, api, { error: 'This address has a password account now. Enter its password.' })
  }
  return created.userId ?? null
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
      await withAccountLink(api, () => finishAccountLink(event, api))
      return
    }
    // Back from the email Form: the address is proven, so the link can be offered.
    if (formId && event.prompt?.id === formId) {
      await withAccountLink(api, () => offerLinkForm(event, api))
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
