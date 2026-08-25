// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { z } from 'zod'

export const STATUS_SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000
export const STATUS_FETCH_TIMEOUT_MS = 10 * 1000
const STATUS_SNAPSHOT_MAX_FUTURE_SKEW_MS = 60 * 1000
const REQUIRED_SERVICE_IDS = ['api', 'runner', 'proxy'] as const

const serviceStatusSchema = z.enum(['operational', 'partial_outage', 'outage'])

const statusSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().datetime(),
    regions: z
      .array(
        z.object({
          id: z.string().min(1),
          status: serviceStatusSchema,
          services: z
            .array(
              z.object({
                id: z.enum(REQUIRED_SERVICE_IDS),
                name: z.enum(['API', 'Runner', 'Proxy']),
                status: serviceStatusSchema,
              }),
            )
            .length(REQUIRED_SERVICE_IDS.length),
        }),
      )
      .min(1),
  })
  .superRefine((snapshot, context) => {
    const regionIds = new Set<string>()

    snapshot.regions.forEach((region, regionIndex) => {
      if (regionIds.has(region.id)) {
        context.addIssue({
          code: 'custom',
          message: `Duplicate region id: ${region.id}`,
          path: ['regions', regionIndex, 'id'],
        })
      }
      regionIds.add(region.id)

      const serviceIds = new Set(region.services.map((service) => service.id))
      if (serviceIds.size !== REQUIRED_SERVICE_IDS.length) {
        context.addIssue({
          code: 'custom',
          message: 'Each region must contain API, Runner, and Proxy exactly once',
          path: ['regions', regionIndex, 'services'],
        })
      }

      region.services.forEach((service, serviceIndex) => {
        const expectedName = service.id === 'api' ? 'API' : service.id === 'runner' ? 'Runner' : 'Proxy'
        if (service.name !== expectedName) {
          context.addIssue({
            code: 'custom',
            message: `Service ${service.id} must use the public name ${expectedName}`,
            path: ['regions', regionIndex, 'services', serviceIndex, 'name'],
          })
        }
      })
    })
  })

export type ServiceStatus = z.infer<typeof serviceStatusSchema>
export type StatusSnapshot = z.infer<typeof statusSnapshotSchema>

export function isStatusSnapshotFresh(snapshot: StatusSnapshot, now = Date.now()): boolean {
  const ageMs = now - Date.parse(snapshot.generatedAt)
  return ageMs >= -STATUS_SNAPSHOT_MAX_FUTURE_SKEW_MS && ageMs <= STATUS_SNAPSHOT_MAX_AGE_MS
}

export function parseStatusSnapshot(input: unknown, now = Date.now()): StatusSnapshot {
  const snapshot = statusSnapshotSchema.parse(input)
  if (!isStatusSnapshotFresh(snapshot, now)) {
    throw new Error('Public status data is outside the accepted freshness window')
  }
  return snapshot
}

export async function fetchStatusSnapshot(url: string, callerSignal?: AbortSignal): Promise<StatusSnapshot> {
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort(callerSignal?.reason)
  const timeoutId = window.setTimeout(
    () => controller.abort(new Error('Public status request timed out')),
    STATUS_FETCH_TIMEOUT_MS,
  )

  if (callerSignal?.aborted) {
    abortFromCaller()
  } else {
    callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
  }

  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal })
    if (!response.ok) {
      throw new Error(`Unable to fetch public status data: HTTP ${response.status}`)
    }
    return parseStatusSnapshot(await response.json())
  } finally {
    window.clearTimeout(timeoutId)
    callerSignal?.removeEventListener('abort', abortFromCaller)
  }
}
