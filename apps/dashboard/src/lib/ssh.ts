/* Copyright 2026 BoxLite AI. SPDX-License-Identifier: AGPL-3.0 */

import type { ApiClient } from '@/api/apiClient'

export type SshStatus = {
  enabled: boolean
  generation: number
  listen_address: string
  host_public_key: string
  host_key_fingerprint: string
}

export async function requestSsh(
  api: ApiClient,
  organizationId: string,
  boxId: string,
  operation: 'status' | 'enable' | 'disable',
): Promise<SshStatus> {
  const path = `v1/${encodeURIComponent(organizationId)}/boxes/${encodeURIComponent(boxId)}/ssh`
  const http = api.axiosInstance
  const options = { timeout: 30_000 }
  const response =
    operation === 'status'
      ? await http.get<SshStatus>(path, options)
      : operation === 'disable'
        ? await http.delete<SshStatus>(path, options)
        : await http.post<SshStatus>(`${path}/enable`, undefined, options)
  const status = response.data
  if (
    !status ||
    typeof status.enabled !== 'boolean' ||
    !Number.isInteger(status.generation) ||
    status.generation < 0 ||
    !['listen_address', 'host_public_key', 'host_key_fingerprint'].every(
      (field) => typeof status[field as keyof SshStatus] === 'string',
    )
  ) {
    throw new Error('Invalid SSH status response')
  }
  return status
}

export type SshInstructions = {
  endpoint: string
  login: string
  connect: string
}

/** Keep login and direct SSH on the Dashboard's endpoint and organization. */
export function sshConnectionInstructions(apiUrl: string, organizationId: string, boxId: string): SshInstructions {
  if (!/^[a-zA-Z0-9_-]+$/.test(boxId)) throw new Error('Invalid box ID')
  const quote = (value: string) => {
    if ([...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
      throw new Error('Invalid connection argument')
    if (/^[a-zA-Z0-9_-]+$/.test(value)) return value
    return `'${value.replace(/'/g, `'"'"'`)}'`
  }
  const url = new URL(apiUrl, window.location.origin)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid API URL')
  const endpoint = url.href.replace(/\/$/, '')
  // A dedicated context keeps saved/ambient context changes from redirecting SSH.
  // Ambient credentials must not override the login saved in this context.
  const cli = `env -u BOXLITE_REST_URL -u BOXLITE_API_KEY boxlite --context ${quote(`dashboard:${endpoint}`)}`
  return {
    connect: `${cli} --path-prefix=${quote(organizationId)} ssh -- ${quote(boxId)}`,
    endpoint,
    login: `${cli} auth login --url ${quote(endpoint)} --method api-key`,
  }
}
