/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import type { ApiClient } from '../api/apiClient'
import type { CiConnectResult, CiWebStart } from '../api/ci-types'

export const CI_CALLBACK_PATH = '/settings/ci/callback'
const pendingKey = 'boxlite.ci.connect'
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
let callback: { code: string; state: string } | undefined
let completion: Promise<{ organization: string; result: CiConnectResult }> | undefined

/** Called before importing the app, telemetry or other third-party modules. */
export function captureCiCallback(): void {
  if (window.location.pathname !== CI_CALLBACK_PATH) return
  const query = new URLSearchParams(window.location.search)
  window.history.replaceState(window.history.state, '', CI_CALLBACK_PATH)
  callback = undefined
  const code = query.get('code'),
    state = query.get('state')
  if (
    query.has('error') ||
    query.getAll('code').length !== 1 ||
    query.getAll('state').length !== 1 ||
    !code ||
    !/^[\x21-\x7e]{1,2048}$/.test(code) ||
    !state ||
    !/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(state)
  )
    return
  callback = { code, state }
}

export function prepareCiRedirect(organization: string, attempt: CiWebStart): string {
  const url = new URL(attempt.authorization_url)
  const expires = Date.parse(attempt.expires_at)
  if (
    !uuid.test(organization) ||
    !uuid.test(attempt.id) ||
    !Number.isFinite(expires) ||
    expires <= Date.now() ||
    expires > Date.now() + 900000 ||
    url.origin !== 'https://github.com' ||
    url.pathname !== '/login/oauth/authorize' ||
    !url.searchParams.get('state')?.startsWith(attempt.id + '.') ||
    url.username ||
    url.password
  )
    throw new Error('Invalid GitHub authorization response. Restart connect.')
  // Only routing metadata survives the redirect. Code, state, verifier and tokens never enter browser storage.
  window.sessionStorage.setItem(pendingKey, JSON.stringify({ attempt: attempt.id, organization, expires }))
  return url.href
}

/** StrictMode mounts and duplicate renders share one completion request. */
export function completeCiRedirect(api: Pick<ApiClient, 'completeCiConnect'>) {
  if (completion) return completion
  completion = (async () => {
    try {
      const pending = JSON.parse(window.sessionStorage.getItem(pendingKey) || 'null')
      if (
        !callback ||
        !pending ||
        !uuid.test(pending.attempt) ||
        !uuid.test(pending.organization) ||
        !Number.isFinite(pending.expires) ||
        pending.expires <= Date.now() ||
        !callback.state.startsWith(pending.attempt + '.')
      )
        throw Error('Restart connect from CI settings.')
      const result = await api.completeCiConnect(pending.organization, pending.attempt, { ...callback })
      return { organization: pending.organization as string, result }
    } catch {
      throw new Error('GitHub authorization could not be completed. Restart connect from CI settings.')
    } finally {
      callback = undefined
      window.sessionStorage.removeItem(pendingKey)
    }
  })()
  return completion
}
