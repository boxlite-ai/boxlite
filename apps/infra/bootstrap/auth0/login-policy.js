// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/**
 * Auth0 Post-Login Action for the BoxLite SPA.
 *
 * New database users are verified by Universal Login before a password is
 * created. Existing unverified database users are sent through the configured
 * Auth0 Form during an interactive browser login. Refresh-token, device-code,
 * and other non-browser exchanges cannot render Forms, so they fail closed.
 */

const BROWSER_PROTOCOLS = new Set(['oidc-basic-profile', 'oidc-hybrid-profile', 'oidc-implicit-profile'])
const BOXLITE_CLIENT_ID = __BOXLITE_CLIENT_ID_JSON__
const BOXLITE_DB_CONNECTION = __BOXLITE_DB_CONNECTION_JSON__
const EMAIL_VERIFICATION_FORM_ID = __EMAIL_VERIFICATION_FORM_ID_JSON__

function isManagedDatabaseLogin(event) {
  return (
    event.client?.client_id === BOXLITE_CLIENT_ID &&
    event.connection?.strategy === 'auth0' &&
    event.connection?.name === BOXLITE_DB_CONNECTION
  )
}

function setIdentityClaims(event, api, emailVerified = event.user?.email_verified === true) {
  if (!event.authorization) return
  api.accessToken.setCustomClaim('email_verified', emailVerified)
  api.accessToken.setCustomClaim('email', event.user?.email)
  api.accessToken.setCustomClaim('name', event.user?.name)
}

exports.onExecutePostLogin = async (event, api) => {
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
  if (!isManagedDatabaseLogin(event) || !formId || event.prompt?.id !== formId) {
    api.access.deny('Email verification failed')
    return
  }

  // The Form resumes only after its verify-OTP flow updates the root Auth0
  // profile. The Action event can still contain the pre-Form user snapshot, so
  // this exact continuation is the point at which the token claim turns true.
  setIdentityClaims(event, api, true)
}
