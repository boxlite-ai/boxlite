/* Copyright 2026 BoxLite AI. SPDX-License-Identifier: AGPL-3.0 */
import { http, HttpResponse, type PathParams } from 'msw'
import type { SshStatus } from '@/lib/ssh'

const states = new Map<string, SshStatus>()
const empty: SshStatus = {
  enabled: false,
  generation: 0,
  listen_address: '',
  host_public_key: '',
  host_key_fingerprint: '',
}
const route = '*/v1/:organizationId/boxes/:boxId/ssh'
const scope = (params: PathParams) => `${params.organizationId}:${params.boxId}`

// Derive the status identity from the configured host key, as the service does.
function hostPublicBlob(privateKey: string) {
  const decoded = atob(privateKey.replace(/-----[^\n]+-----/g, '').replace(/\s/g, ''))
  if (!decoded.startsWith('openssh-key-v1\0')) throw new Error('Invalid mock SSH key')
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  let offset = 15
  const uint32 = () => {
    const value = view.getUint32(offset)
    offset += 4
    return value
  }
  const string = () => {
    const size = uint32()
    if (offset + size > bytes.length) throw new Error('Invalid mock SSH key')
    const value = bytes.slice(offset, offset + size)
    offset += size
    return value
  }
  if (new TextDecoder().decode(string()) !== 'none') throw new Error('Encrypted mock SSH key')
  string() // KDF name.
  string() // KDF options.
  if (uint32() !== 1) throw new Error('Invalid mock SSH key count')
  const publicBlob = string()
  if (!string().length) throw new Error('Missing mock SSH private-key block')
  return publicBlob
}

function visibleStatus(saved: SshStatus = empty): SshStatus {
  return saved.enabled ? saved : { ...empty, generation: saved.generation }
}

export const sshHandlers = [
  http.get(route, ({ params }) => HttpResponse.json(visibleStatus(states.get(scope(params))))),
  http.post(route, async ({ params, request }) => {
    let publicBlob: Uint8Array<ArrayBuffer>
    try {
      const config = (await request.json()) as { host_private_key?: unknown }
      if (typeof config.host_private_key !== 'string') throw new Error('Missing mock SSH key')
      publicBlob = hostPublicBlob(config.host_private_key)
    } catch {
      return HttpResponse.json({ message: 'Invalid SSH configuration' }, { status: 400 })
    }
    const fingerprint = new Uint8Array(await crypto.subtle.digest('SHA-256', publicBlob))
    const state = {
      enabled: true,
      generation: (states.get(scope(params))?.generation ?? 0) + 1,
      listen_address: '0.0.0.0:22',
      host_public_key: `ssh-ed25519 ${btoa(String.fromCharCode(...publicBlob))}`,
      host_key_fingerprint: `SHA256:${btoa(String.fromCharCode(...fingerprint)).replace(/=+$/, '')}`,
    }
    states.set(scope(params), state)
    return HttpResponse.json(state)
  }),
  http.post(`${route}/enable`, ({ params }) => {
    const saved = states.get(scope(params))
    if (!saved) return HttpResponse.json({ message: 'SSH has no saved configuration' }, { status: 409 })
    const state = { ...saved, enabled: true, generation: saved.enabled ? saved.generation : saved.generation + 1 }
    states.set(scope(params), state)
    return HttpResponse.json(state)
  }),
  http.delete(route, ({ params }) => {
    const saved = states.get(scope(params))
    if (saved) states.set(scope(params), { ...saved, enabled: false })
    return HttpResponse.json(visibleStatus({ ...(saved ?? empty), enabled: false }))
  }),
]
