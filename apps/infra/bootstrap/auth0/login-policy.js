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
 * A login is folded into the account that already holds its address before
 * any token is issued, without leaving Auth0. The person proves that
 * account is theirs: its password, checked with the password-realm grant, or,
 * when only social accounts hold the address, the code the email Form mails.
 * Google on a Gmail address needs neither, since Google serves that mailbox,
 * and a fresh password sign-up has proven its mailbox already. A password
 * account with MFA is never linked: no proof here checks a second factor. The
 * BoxLite API moves the folded user's data, and the Management API links the
 * identities. With no API origin or link Form configured the step is off, and
 * every login keeps its own identity.
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

// The API refuses a request signed for any audience but the one it serves.
const ADOPT_AUDIENCE = 'boxlite-account-link-adopt'
const STATUS_AUDIENCE = 'boxlite-account-link-status'
const PASSWORD_REALM_GRANT = 'http://auth0.com/oauth/grant-type/password-realm'
// Gmail addresses, whose mail Google itself serves.
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com'])

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
 * An interactive BoxLite browser login, through the database connection or a
 * social one, whose user has a single sign-in. A user already linked reaches
 * its account directly, so this stops matching once the link is made. A token
 * refresh or other exchange keeps the identity it has until the next browser
 * login: it cannot show a Form, and the Management API lookup would otherwise
 * run on every refresh.
 */
function needsAccountLink(event) {
  return (
    Boolean(ACCOUNT_LINK_API_ORIGIN && ACCOUNT_LINK_FORM_ID && AUTH0_DOMAIN) &&
    isBoxLiteBrowserLogin(event) &&
    event.user?.identities?.length === 1 &&
    (event.connection?.strategy !== 'auth0' || event.connection?.name === BOXLITE_DB_CONNECTION)
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

// A password account enrolled in MFA, which Auth0 lists in `multifactor`.
// Neither its password grant nor a Gmail sign-in checks the second factor, so
// it is never linked.
function passwordWithMfa(user) {
  return holdsPassword(user) && (user.multifactor ?? []).length > 0
}

// Password, then Google, then GitHub: an account ranks as its best sign-in.
function rank(user) {
  const ranks = (user.identities ?? []).map((identity) =>
    identity.connection === BOXLITE_DB_CONNECTION ? 3 : ({ 'google-oauth2': 2, github: 1 }[identity.provider] ?? 0),
  )
  return Math.max(0, ...ranks)
}

/**
 * Whether this login has proven its mailbox by itself: Google signing in a
 * Gmail address, mail Google serves; or a password sign-up's first login,
 * whose address Universal Login has just verified with a code.
 */
function provesMailbox(event) {
  if (event.user.email_verified !== true) return false
  if (event.connection?.strategy === 'google-oauth2') {
    return GMAIL_DOMAINS.has(String(event.user.email).toLowerCase().split('@')[1])
  }
  return isManagedDatabaseLogin(event) && event.stats?.logins_count === 1
}

// A link page shows only right after the sign-in. A login that reuses an
// older one from its Auth0 session is the app opened again around a link page
// left unanswered. (api.cache cannot mark that session: it is not shared
// between executions reliably.)
const FRESH_SIGN_IN_MS = 15 * 1000

function signedInJustNow(event) {
  const times = (event.authentication?.methods ?? [])
    .map((method) => Date.parse(method.timestamp))
    .filter((time) => !Number.isNaN(time))
  // No record of the sign-in says nothing about its age; showing the page is
  // the safe answer.
  if (times.length === 0) return true
  return Date.now() - Math.max(...times) < FRESH_SIGN_IN_MS
}

/**
 * Ends this login and the Auth0 session it opened, then sends the person to
 * the app, which starts at the login page again. A denial would keep the
 * session, so the app's next login would come straight back to the link page.
 */
function endLogin(event, api) {
  const hostname = event.request?.hostname
  const redirectUri = event.transaction?.redirect_uri
  if (!hostname || !redirectUri) {
    api.access.deny('Account linking was cancelled')
    return
  }
  const logout = new URL(`https://${hostname}/v2/logout`)
  logout.searchParams.set('client_id', event.client.client_id)
  // Auth0 returns only to an Allowed Logout URL: the client allows the
  // dashboard's https origin, not the CLI's loopback callback. Without a
  // returnTo, Auth0 goes to the client's first Allowed Logout URL instead.
  const redirect = new URL(redirectUri)
  if (redirect.protocol === 'https:') logout.searchParams.set('returnTo', redirect.origin)
  api.redirect.sendUserTo(logout.toString())
}

const PROVIDER_LABELS = { auth0: 'email and password', github: 'GitHub', 'google-oauth2': 'Google' }

/** The link page, asking for the account's password, or to continue to a code. */
function renderLinkForm(event, api, { mode, error = '' }) {
  const provider = PROVIDER_LABELS[event.connection?.strategy] ?? event.connection?.name ?? 'social'
  api.prompt.render(ACCOUNT_LINK_FORM_ID, {
    vars: {
      title: `Link your ${provider} sign-in`,
      lead:
        mode === 'password'
          ? 'An account already uses this email. Enter its password to link them.'
          : 'An account already uses this email. Continue to get a code at this address, then enter it to link them.',
      error,
      // `mode` lets the address field hide the password in code mode. The
      // address is shown greyed out, and a fresh id per render lets the cancel
      // field read a second load of one id as a refresh. All three reach the
      // custom fields as params; Forms gives a custom field no prefilled value.
      mode,
      address: event.user.email,
      render: require('crypto').randomUUID(),
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

/** Whether BoxLite already has this user, that is, it has signed in before. */
async function boxliteKnows(event, userId) {
  const response = await fetch(`${ACCOUNT_LINK_API_ORIGIN}/api/auth/link/status`, {
    headers: { authorization: `Bearer ${signLinkRequest(event, STATUS_AUDIENCE, { sub: userId })}` },
  })
  if (response.status !== 200) throw new Error(`the BoxLite API answered ${response.status} to status`)
  return (await response.json()).known === true
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
 * The account that stays. One that already joins several sign-ins stays, so
 * no linked sign-in moves twice. Otherwise the highest-ranked does, and this
 * login counts only when BoxLite already knows its user: a new one joins what
 * exists and makes no organization of its own.
 */
async function accountThatStays(event, accounts) {
  const joined = accounts.find((user) => (user.identities?.length ?? 0) > 1)
  if (joined) return joined
  const best = accounts.reduce((top, user) => (rank(user) > rank(top) ? user : top))
  if (rank(event.user) > rank(best) && (await boxliteKnows(event, event.user.user_id))) return event.user
  return best
}

/**
 * Folds this login and `accounts` into one. Local data moves before the
 * tenant link: once linked, later logins reach the account directly and never
 * pass here again, so anything not yet moved would stay stranded, while a
 * failed link is simply retried at the next login.
 */
async function fold(event, api, accounts) {
  const stays = await accountThatStays(event, accounts)
  const folded = [event.user, ...accounts].filter((user) => user.user_id !== stays.user_id)
  for (const user of folded) await adopt(event, stays.user_id, user.user_id)
  for (const user of folded) await link(event, api, stays.user_id, user.user_id)
  if (stays.user_id !== event.user.user_id) api.authentication.setPrimaryUser(stays.user_id)
  setIdentityClaims(event, api, true)
}

/**
 * Folds this login into the accounts holding its address once the mailbox is
 * proven, or shows the link page that asks for the proof. `mailboxProven` is
 * set right after the email Form has checked a code.
 */
async function planLink(event, api, { mailboxProven = false, entry = false } = {}) {
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
  if (accounts.length === 0 || accounts.some(passwordWithMfa)) {
    setIdentityClaims(event, api, emailVerified)
    return
  }
  const password = accounts.some(holdsPassword)
  // A login that proves its mailbox by itself folds every account holding the
  // address, a password one too. A code from the email Form folds social
  // accounts only; a password account asks for its password.
  if (provesMailbox(event) || (mailboxProven && !password)) {
    await fold(event, api, accounts)
    return
  }
  // A link page reached by reusing an earlier sign-in from the session is the
  // app opened again around one left unanswered, so it starts over at the
  // login page instead.
  if (entry && !signedInJustNow(event)) {
    endLogin(event, api)
    return
  }
  renderLinkForm(event, api, { mode: password ? 'password' : 'code' })
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
  await planLink(event, api, { entry: true })
}

/**
 * Cancel, or a second load of the page. A user BoxLite already knows goes on
 * unlinked and is asked again at its next login; a new one would make a
 * second account, so its login and session end at the login page instead.
 */
async function cancelLink(event, api) {
  if (await boxliteKnows(event, event.user.user_id)) {
    setIdentityClaims(event, api)
    return
  }
  endLogin(event, api)
}

/** The link page came back: cancelled, with a password, or to get a code. */
async function answerLinkForm(event, api) {
  const fields = event.prompt?.fields ?? {}
  if (fields.cancel === 'cancel') {
    await cancelLink(event, api)
    return
  }
  const accounts = await otherAccounts(event, api)
  const passwordAccount = accounts.find(holdsPassword)
  if (!passwordAccount) {
    if (accounts.length === 0) {
      setIdentityClaims(event, api)
      return
    }
    // Only social accounts hold the address: the code the email Form mails
    // there proves it.
    if (!EMAIL_VERIFICATION_FORM_ID) {
      api.access.deny('Email verification is unavailable')
      return
    }
    api.prompt.render(EMAIL_VERIFICATION_FORM_ID)
    return
  }
  const password = fields.password
  if (typeof password !== 'string' || password === '') {
    renderLinkForm(event, api, { mode: 'password', error: 'Enter the password.' })
    return
  }
  if (!(await provePassword(event, api, passwordAccount, password))) return
  // The password proves its own account; social ones join at their own next
  // login. (A login that proves its mailbox never reaches this page.)
  await fold(event, api, [passwordAccount])
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
      renderLinkForm(event, api, { mode: 'password', error: 'That password is not right. Try again.' })
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
    // Back from the email Form: its code proved the mailbox.
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
