import { z } from 'zod'

export const STATUS_SNAPSHOT_MAX_AGE_MS = 5 * 60 * 1000

const serviceStatusSchema = z.enum(['operational', 'disruption', 'partial_outage', 'outage', 'maintenance'])

const statusSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().datetime(),
  regions: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        status: serviceStatusSchema,
        services: z
          .array(
            z.object({
              id: z.string().min(1),
              name: z.string().min(1),
              status: serviceStatusSchema,
            }),
          )
          .min(1),
      }),
    )
    .min(1),
})

export type ServiceStatus = z.infer<typeof serviceStatusSchema>
export type StatusSnapshot = z.infer<typeof statusSnapshotSchema>

export class StaleStatusSnapshotError extends Error {
  constructor() {
    super('The public status snapshot is stale')
    this.name = 'StaleStatusSnapshotError'
  }
}

export function parseStatusSnapshot(
  input: unknown,
  now = Date.now(),
  maxAgeMs = STATUS_SNAPSHOT_MAX_AGE_MS,
): StatusSnapshot {
  const snapshot = statusSnapshotSchema.parse(input)
  const generatedAt = Date.parse(snapshot.generatedAt)

  if (now - generatedAt > maxAgeMs) {
    throw new StaleStatusSnapshotError()
  }

  return snapshot
}

export async function fetchStatusSnapshot(url: string, signal?: AbortSignal): Promise<StatusSnapshot> {
  const response = await fetch(url, { cache: 'no-store', signal })

  if (!response.ok) {
    throw new Error(`Unable to fetch public status snapshot: HTTP ${response.status}`)
  }

  return parseStatusSnapshot(await response.json())
}
