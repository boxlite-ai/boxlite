/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { http, HttpResponse } from 'msw'
import { BoxState, NetworkMode } from '@boxlite-ai/api-client'
import { MOCK_BOXES } from './fixtures'

// Presentation-only public declarations for Console previews.
const declarations = new Map<string, { isPublic: boolean; token: string | null }>()
const resumable = new Set<BoxState>([
  BoxState.STOPPED,
  BoxState.STOPPING,
  BoxState.STARTING,
  BoxState.CREATING,
  BoxState.RESTORING,
])
const endpoint = '*/v1/:organizationId/boxes/:boxId/network/tunnel'
export const tunnelHandlers = [
  http.post(endpoint, async ({ params, request }) => {
    const box = MOCK_BOXES.find((box) => box.id === params.boxId && box.organizationId === params.organizationId)
    if (!box) return HttpResponse.json({ message: 'Box not found' }, { status: 404 })
    const port = Number(new URL(request.url).searchParams.get('port'))
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return HttpResponse.json({ message: 'Invalid port' }, { status: 400 })
    if (box.network?.inbound.mode !== NetworkMode.ENABLED)
      return HttpResponse.json({ message: 'Box has inbound access disabled' }, { status: 409 })
    if (box.state !== BoxState.STARTED && (!box.autoResume || !box.state || !resumable.has(box.state)))
      return HttpResponse.json({ message: 'Box is not running' }, { status: 409 })
    const body = (await request.json()) as { isPublic?: boolean }
    if (body.isPublic !== undefined && typeof body.isPublic !== 'boolean')
      return HttpResponse.json({ message: 'Invalid access mode' }, { status: 400 })
    if (body.isPublic !== true)
      return HttpResponse.json({ message: 'Only public creation is available in the Console' }, { status: 400 })
    const isPublic = true
    const token = null
    declarations.set(`${params.organizationId}:${box.id}:${port}`, { isPublic, token })
    const encoded = [...box.id].map((char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    return HttpResponse.json({ uri: `https://${port}-d-${encoded}.proxy.mock.boxlite.ai`, isPublic, token })
  }),
  http.delete(endpoint, ({ params, request }) => {
    const box = MOCK_BOXES.find((box) => box.id === params.boxId && box.organizationId === params.organizationId)
    if (!box) return HttpResponse.json({ message: 'Box not found' }, { status: 404 })
    const port = Number(new URL(request.url).searchParams.get('port'))
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return HttpResponse.json({ message: 'Invalid port' }, { status: 400 })
    declarations.delete(`${params.organizationId}:${box.id}:${port}`)
    return new HttpResponse(null, { status: 204 })
  }),
]
