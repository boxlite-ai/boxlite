/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { http, HttpResponse } from 'msw'
import { Box, BoxState, BoxDesiredState } from '@boxlite-ai/api-client'
import { Snapshot } from '@/lib/cloudSnapshot'
import { MOCK_BOXES } from './fixtures'
import { isSnapshotBoxIdle, isSnapshotNameValid } from '@/lib/snapshots'

const randomName = () => ['cozy-otter', 'brisk-fox', 'calm-heron'][Math.floor(Math.random() * 3)]

export function snapshotHandlers(apiUrl: string) {
  const now = new Date().toISOString()
  const snapshots: Snapshot[] = [
    {
      id: 'snapshot-before-deploy',
      name: 'before-deploy',
      sourceBoxId: 'mock-box-stopped',
      status: 'ready',
      sizeBytes: 731906048,
      diskGb: 20,
      createdAt: now,
    },
    {
      id: 'snapshot-retired-source',
      name: 'retired-worker',
      sourceBoxId: 'deleted-box',
      status: 'ready',
      sizeBytes: 284164096,
      diskGb: 10,
      createdAt: now,
    },
    {
      id: 'snapshot-failed',
      name: 'nightly-backup',
      sourceBoxId: 'mock-box-agent-2',
      status: 'failed',
      error: 'The runner disconnected before the archive finished uploading.',
      sizeBytes: 0,
      diskGb: 10,
      createdAt: now,
    },
  ]
  const initializing = new Set<string>()
  const response = (snapshot: Snapshot) => ({
    id: snapshot.id,
    name: snapshot.name,
    box_id: snapshot.sourceBoxId,
    status: snapshot.status,
    error: snapshot.error,
    size_bytes: snapshot.sizeBytes,
    container_disk_bytes: snapshot.diskGb * 1024 ** 3,
    guest_disk_bytes: 0,
    created_at: Math.floor(Date.parse(snapshot.createdAt) / 1000),
  })
  const conflict = (message: string) => HttpResponse.json({ error: { message } }, { status: 409 })
  return [
    http.get(`${apiUrl}/v1/config`, () =>
      HttpResponse.json({
        capabilities: {
          snapshots_enabled: true,
          create_from_snapshot_enabled: true,
          snapshot_copy_enabled: false,
          memory_snapshots_enabled: false,
        },
      }),
    ),
    http.get(`${apiUrl}/v1/:org/snapshots`, () => HttpResponse.json({ snapshots: snapshots.map(response) })),
    http.post(`${apiUrl}/v1/:org/boxes/:boxId/snapshots`, async ({ params, request }) => {
      const box = MOCK_BOXES.find((item) => item.id === params.boxId)
      if (!box || !isSnapshotBoxIdle(box)) return conflict('The source box must be stopped')
      const body = (await request.json()) as { name?: string }
      const id = crypto.randomUUID()
      let name = body.name?.trim() || randomName()
      if (!body.name?.trim() && snapshots.some((item) => item.name === name)) name = `${name}-${id}`
      if (!isSnapshotNameValid(name))
        return HttpResponse.json({ error: { message: 'Invalid snapshot name' } }, { status: 400 })
      if (snapshots.some((item) => item.name === name && item.status !== 'failed'))
        return conflict(`A snapshot named ${name} already exists`)
      const snapshot: Snapshot = {
        id,
        name,
        sourceBoxId: box.id,
        status: 'creating',
        sizeBytes: 0,
        diskGb: box.disk!,
        createdAt: new Date().toISOString(),
      }
      snapshots.unshift(snapshot)
      box.state = BoxState.EXPORTING
      setTimeout(() => {
        snapshot.status = 'ready'
        snapshot.sizeBytes = 398458880
        box.state = BoxState.STOPPED
      }, 6500)
      return HttpResponse.json(response(snapshot), { status: 201 })
    }),
    http.post(`${apiUrl}/v1/:org/snapshots/:snapshotId/boxes`, async ({ params, request }) => {
      const snapshot = snapshots.find((item) => item.id === params.snapshotId)
      if (!snapshot || snapshot.status !== 'ready') return conflict('Only a ready snapshot can create a box')
      const body = (await request.json()) as { name?: string }
      const id = crypto.randomUUID()
      let name = body.name?.trim() || randomName()
      if (!body.name?.trim() && MOCK_BOXES.some((item) => item.name === name)) name = `${name}-${id}`
      if (MOCK_BOXES.some((box) => box.name === name && box.state !== BoxState.DESTROYED))
        return conflict(`Box with name ${name} already exists`)
      const box: Box = {
        ...MOCK_BOXES[0],
        id,
        name,
        disk: snapshot.diskGb,
        volumes: [],
        env: {},
        state: BoxState.CREATING,
        desiredState: BoxDesiredState.STARTED,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      MOCK_BOXES.unshift(box)
      initializing.add(snapshot.id)
      setTimeout(() => {
        box.state = BoxState.STARTED
        initializing.delete(snapshot.id)
      }, 6500)
      return HttpResponse.json({ box_id: box.id, name, status: 'configured' }, { status: 201 })
    }),
    http.delete(`${apiUrl}/v1/:org/snapshots/:snapshotId`, ({ params }) => {
      const index = snapshots.findIndex((item) => item.id === params.snapshotId)
      if (index < 0) return new HttpResponse(null, { status: 404 })
      const snapshot = snapshots[index]
      if (snapshot.status === 'creating' || initializing.has(snapshot.id)) return conflict('Snapshot is still in use')
      snapshots.splice(index, 1)
      return new HttpResponse(null, { status: 204 })
    }),
  ]
}
