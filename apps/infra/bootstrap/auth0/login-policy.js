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
 * A social login that is not yet part of a password account is linked into
 * one before any token is issued (POL-555): the browser goes to the BoxLite
 * API, which runs a second sign-in against the database connection and links
 * the identities, and comes back here so the token names the password
 * account. An address the social provider has not verified is proven with the
 * same email Form first. With no API origin configured the step is off, and
 * social logins keep their own identity as before.
 */

const BROWSER_PROTOCOLS = new Set(['oidc-basic-profile', 'oidc-hybrid-profile', 'oidc-implicit-profile'])
const BOXLITE_CLIENT_ID = __BOXLITE_CLIENT_ID_JSON__
const BOXLITE_DB_CONNECTION = __BOXLITE_DB_CONNECTION_JSON__
const EMAIL_VERIFICATION_FORM_ID = __EMAIL_VERIFICATION_FORM_ID_JSON__
// Where the BoxLite API is served. Empty turns the account link off.
const ACCOUNT_LINK_API_ORIGIN = __ACCOUNT_LINK_API_ORIGIN_JSON__
const ACCOUNT_LINK_START_URL = ACCOUNT_LINK_API_ORIGIN && `${ACCOUNT_LINK_API_ORIGIN}/api/auth/link/start`
// Registered on this client by the same configurator run that wrote the origin
// above, so the API can take it from the session token rather than guess it.
const ACCOUNT_LINK_CALLBACK_URL = ACCOUNT_LINK_API_ORIGIN && `${ACCOUNT_LINK_API_ORIGIN}/api/auth/link/callback`

// The query parameter the BoxLite API returns its outcome in on /continue.
const LINK_TOKEN_PARAMETER = 'link_token'
// Long enough for one browser hop to the API; the API re-signs everything
// after that under its own, separate lifetime.
const LINK_SESSION_TTL_SECONDS = 300

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
 * A BoxLite login through anything but the database connection, whose user is
 * not a password account yet. Once linked, Auth0 answers the same social login
 * with the password account's `auth0|` user, so this stops matching by itself.
 */
function needsAccountLink(event) {
  return (
    Boolean(ACCOUNT_LINK_START_URL) &&
    event.client?.client_id === BOXLITE_CLIENT_ID &&
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

function sendToAccountLink(event, api) {
  const sessionToken = api.redirect.encodeToken({
    secret: event.secrets.ACCOUNT_LINK_SECRET,
    expiresInSeconds: LINK_SESSION_TTL_SECONDS,
    payload: { email: event.user.email, connection: BOXLITE_DB_CONNECTION, callback: ACCOUNT_LINK_CALLBACK_URL },
  })
  api.redirect.sendUserTo(ACCOUNT_LINK_START_URL, { query: { session_token: sessionToken } })
}

function startAccountLink(event, api) {
  if (!event.user?.email) {
    api.access.deny('This sign-in has no email address to link to a BoxLite account')
    return
  }
  if (!isBoxLiteBrowserLogin(event)) {
    api.access.deny('Sign in through a browser to link this login to your BoxLite account')
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
  sendToAccountLink(event, api)
}

/**
 * Finish on the BoxLite API's outcome.
 *
 * `setPrimaryUser` has to be called here, in the continuation of the Action
 * that redirected: Auth0 loses a primary-user change made before a redirect.
 * https://support.auth0.com/center/s/article/Account-Linking-with-Actions-setPrimaryUser-update-lost-between-redirects
 */
function finishAccountLink(event, api) {
  let outcome
  try {
    outcome = api.redirect.validateToken({
      secret: event.secrets.ACCOUNT_LINK_SECRET,
      tokenParameterName: LINK_TOKEN_PARAMETER,
    })
  } catch (error) {
    api.access.deny('Account linking could not be verified')
    return
  }

  if (outcome.outcome !== 'linked' || typeof outcome.primary_user_id !== 'string') {
    api.access.deny(
      outcome.outcome === 'mismatch'
        ? 'That password account does not hold the address this login uses'
        : 'Account linking did not complete',
    )
    return
  }

  api.authentication.setPrimaryUser(outcome.primary_user_id)
  // The callback linked only a password account whose own address is verified
  // and equal to this one, so the token may say so.
  setIdentityClaims(event, api, true)
}

exports.onExecutePostLogin = async (event, api) => {
  if (needsAccountLink(event)) {
    startAccountLink(event, api)
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
    if (event.request?.query?.[LINK_TOKEN_PARAMETER]) {
      finishAccountLink(event, api)
      return
    }
    // Back from the email Form: the address is proven, so the link can start.
    if (formId && event.prompt?.id === formId) {
      sendToAccountLink(event, api)
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
