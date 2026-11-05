/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import type { ApiClient } from '../api/apiClient'
import type { CiConnectResult, CiWebStart } from '../api/ci-types'

export const CI_CALLBACK_PATH = '/settings/ci/callback'
const pendingKey = 'boxlite.ci.connect'
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
let callback:
  | { kind: 'oauth'; code: string; state: string }
  | { kind: 'installation'; installation_id: number; state: string }
  | undefined
let completion: Promise<{ organization: string; result: CiConnectResult }> | undefined

/** Called before importing the app, telemetry or other third-party modules. */
export function captureCiCallback(): void {
  if (window.location.pathname !== CI_CALLBACK_PATH) return
  if (!window.location.search) return
  completion = undefined
  const query = new URLSearchParams(window.location.search)
  window.history.replaceState(window.history.state, '', CI_CALLBACK_PATH)
  callback = undefined
  const code = query.get('code'),
    state = query.get('state')
  if (
    query.has('error') ||
    query.getAll('state').length !== 1 ||
    !state ||
    !/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(state)
  )
    return
  if (
    code &&
    query.getAll('code').length === 1 &&
    /^[\x21-\x7e]{1,2048}$/.test(code) &&
    !query.has('installation_id') &&
    !query.has('setup_action')
  ) {
    callback = { kind: 'oauth', code, state }
  } else if (
    !query.has('code') &&
    query.getAll('installation_id').length === 1 &&
    query.getAll('setup_action').length === 1 &&
    ['install', 'update'].includes(query.get('setup_action') || '')
  ) {
    const value = query.get('installation_id') || '',
      id = Number(value)
    if (/^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(id))
      callback = { kind: 'installation', installation_id: id, state }
  }
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
  completion = undefined
  callback = undefined
  window.sessionStorage.setItem(pendingKey, JSON.stringify({ attempt: attempt.id, organization, expires }))
  return url.href
}

/** StrictMode mounts and duplicate renders share one completion request. */
export function completeCiRedirect(api: Pick<ApiClient, 'completeCiConnect' | 'completeCiInstallation'>) {
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
      const result =
        callback.kind === 'oauth'
          ? await api.completeCiConnect(pending.organization, pending.attempt, {
              code: callback.code,
              state: callback.state,
            })
          : await api.completeCiInstallation(pending.organization, pending.attempt, {
              installation_id: callback.installation_id,
              state: callback.state,
            })
      if (result.status !== 'selection_required') window.sessionStorage.removeItem(pendingKey)
      return { organization: pending.organization as string, result }
    } catch {
      window.sessionStorage.removeItem(pendingKey)
      throw new Error('GitHub authorization could not be completed. Restart connect from CI settings.')
    } finally {
      callback = undefined
    }
  })()
  return completion
}

export function clearCiConnectSession(): void {
  window.sessionStorage.removeItem(pendingKey)
}
