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

export const sshHandlers = [
  http.get(route, ({ params }) => HttpResponse.json(states.get(scope(params)) ?? empty)),
  http.post(route, ({ params }) => {
    const state = {
      enabled: true,
      generation: (states.get(scope(params))?.generation ?? 0) + 1,
      listen_address: '0.0.0.0:22',
      host_public_key: 'mock-host-public-key',
      host_key_fingerprint: 'SHA256:mock-preview-only',
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
    return HttpResponse.json({ ...(saved ?? empty), enabled: false })
  }),
]
