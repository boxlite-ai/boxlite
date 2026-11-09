// Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0
// Preview-only state: no VM, archive or object storage is created here.
import type { Checkpoint } from '@/api/checkpoint-types'
import { Box, BoxDesiredState, BoxState } from '@boxlite-ai/api-client'
import { http, HttpResponse } from 'msw'
import { MOCK_BOXES, MOCK_PAGINATED_BOXES, buildBox } from './fixtures'

const records = new Map<string, Map<string, { info: Checkpoint; source: Box }>>()
function recordsFor(org: string) {
  let rows = records.get(org)
  if (!rows) {
    // Archive state is independent of the current Box inventory, including
    // when the user deleted every source before opening this preview page.
    const source = buildBox({
      id: 'deleted-source-box',
      name: 'saved-source',
      state: BoxState.STOPPED,
      cpu: 2,
      memory: 4,
      disk: 20,
    })
    const info: Checkpoint = {
      id: 'mock-checkpoint-base',
      name: 'python-base',
      source_box_id: 'deleted-source-box',
      created_at: new Date().toISOString(),
      size_bytes: 16_777_216,
      state: 'ready',
    }
    rows = new Map([[info.id, { info, source }]])
    records.set(org, rows)
  }
  return rows
}

function boxResponse(box: Box) {
  return {
    box_id: box.id,
    name: box.name,
    status: box.state,
    created_at: box.createdAt,
    updated_at: box.updatedAt,
    image: box.image,
    cpus: box.cpu,
    memory_mib: (box.memory ?? 1) * 1024,
    labels: box.labels,
  }
}

function readySource(org: string, key: string) {
  const record = recordsFor(org).get(key)
  return record?.info.state === 'ready' ? record.source : undefined
}

export function createMockCheckpointBox(org: string, key: string, name?: string) {
  const source = readySource(org, key)
  if (!source) return HttpResponse.json({ message: 'Checkpoint is not ready' }, { status: 409 })
  const id = `mock-box-${crypto.randomUUID()}`
  const box = {
    ...structuredClone(source),
    id,
    name: name || id,
    organizationId: org,
    state: BoxState.STARTED,
    desiredState: BoxDesiredState.STARTED,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
  MOCK_BOXES.unshift(box)
  MOCK_PAGINATED_BOXES.items = MOCK_BOXES
  MOCK_PAGINATED_BOXES.total = MOCK_BOXES.length
  return HttpResponse.json(boxResponse(box), { status: 201 })
}

export const checkpointHandlers = [
  http.get('*/v1/config', () => HttpResponse.json({ capabilities: { checkpoints_enabled: true } })),
  http.get('*/v1/:organizationId/checkpoints', ({ params }) => {
    const rows = [...recordsFor(String(params.organizationId)).values()]
    const checkpoints = rows.map((record) => ({ ...record.info }))
    // One visible poll in creating, then the next poll observes completion.
    for (const record of rows)
      if (record.info.state === 'creating') {
        record.info.state = 'ready'
        record.info.size_bytes = 16_777_216
      }
    return HttpResponse.json({ checkpoints })
  }),
  http.post('*/v1/:organizationId/checkpoints', async ({ params, request }) => {
    const body = (await request.json()) as { source_box_id: string; name?: string }
    const source = MOCK_BOXES.find((box) => box.id === body.source_box_id || box.name === body.source_box_id)
    if (!source) return HttpResponse.json({ message: 'Source Box not found' }, { status: 404 })
    if (source.state !== BoxState.STARTED && source.state !== BoxState.STOPPED)
      return HttpResponse.json({ message: 'Source Box must be idle and started or stopped' }, { status: 409 })
    if (source.volumes?.length)
      return HttpResponse.json({ message: 'Sources with volumes cannot be captured' }, { status: 400 })
    const rows = recordsFor(String(params.organizationId))
    const id = `mock-checkpoint-${crypto.randomUUID()}`
    const name = body.name || id
    if ([...rows.values()].some((record) => record.info.name === name))
      return HttpResponse.json({ message: 'Checkpoint name already exists' }, { status: 409 })
    const info: Checkpoint = {
      id,
      name,
      source_box_id: source.id,
      created_at: new Date().toISOString(),
      size_bytes: 0,
      state: 'creating',
    }
    rows.set(id, { info, source: structuredClone(source) })
    return HttpResponse.json(info, { status: 201 })
  }),
  http.delete('*/v1/:organizationId/checkpoints/:key', ({ params }) => {
    const rows = recordsFor(String(params.organizationId))
    if (rows.get(String(params.key))?.info.state === 'creating')
      return HttpResponse.json({ message: 'Checkpoint is being captured' }, { status: 409 })
    if (!rows.delete(String(params.key))) return HttpResponse.json({ message: 'Checkpoint not found' }, { status: 404 })
    return new HttpResponse(null, { status: 204 })
  }),
]
