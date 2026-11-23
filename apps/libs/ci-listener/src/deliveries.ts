/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
export interface GitHubDelivery {
  id: string
  guid: string
  deliveredAt: number
  statusCode: number | null
  event: string
  action: string | null
  installationId: number | null
  repositoryId: number | null
}
export interface GitHubDeliveryPage {
  deliveries: GitHubDelivery[]
  cursor: string | null
}
export class DeliveryPaginationError extends Error {}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const name = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(value)
export function deliveryId(value: unknown): string {
  const decimal = positive(value) ? String(value) : value
  if (typeof decimal !== 'string' || !/^[1-9][0-9]{0,31}$/.test(decimal))
    throw new Error('Invalid GitHub delivery identity')
  return decimal
}
export function deliveryCursor(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value.length ||
    Buffer.byteLength(value) > 2048 ||
    Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new Error('Invalid GitHub delivery cursor')
  return value
}
function nextCursor(link: unknown, previous?: string): string | null {
  if (link === null || link === '') return null
  if (typeof link !== 'string' || Buffer.byteLength(link) > 8192)
    throw new DeliveryPaginationError('Invalid GitHub delivery pagination')
  const pattern = /<([^<>]+)>;\s*rel="(next|prev|first|last)"/g,
    links = [...link.matchAll(pattern)]
  if (!links.length || !/^[,\s]*$/.test(link.replace(pattern, '')))
    throw new DeliveryPaginationError('Invalid GitHub delivery pagination')
  const next = links.filter((item) => item[2] === 'next')
  if (next.length > 1) throw new DeliveryPaginationError('Duplicate GitHub delivery next link')
  if (!next.length) return null
  let url: URL
  try {
    url = new URL(next[0][1])
  } catch {
    throw new DeliveryPaginationError('Invalid GitHub delivery next route')
  }
  const keys = [...url.searchParams.keys()]
  if (
    url.origin !== 'https://api.github.com' ||
    url.pathname !== '/app/hook/deliveries' ||
    url.username ||
    url.password ||
    url.hash ||
    keys.length !== 2 ||
    !keys.includes('per_page') ||
    !keys.includes('cursor') ||
    url.searchParams.get('per_page') !== '100'
  )
    throw new DeliveryPaginationError('Invalid GitHub delivery next route')
  const cursor = deliveryCursor(url.searchParams.get('cursor'))
  if (cursor === previous) throw new DeliveryPaginationError('GitHub delivery pagination did not advance')
  return cursor
}
/** A complete validated page; no partial array is published when metadata or pagination is invalid. */
export function decodeDeliveryPage(value: unknown, previous?: string): GitHubDeliveryPage {
  if (!object(value) || !Array.isArray(value.data) || value.data.length > 100)
    throw new Error('Invalid GitHub delivery page')
  const cursor = nextCursor(value.link, previous),
    seen = new Set<string>(),
    deliveries = value.data.map((item: unknown): GitHubDelivery => {
      if (
        !object(item) ||
        typeof item.guid !== 'string' ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(item.guid) ||
        typeof item.delivered_at !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(item.delivered_at) ||
        !name(item.event) ||
        !(item.action === null || name(item.action)) ||
        !(item.installation_id === null || positive(item.installation_id)) ||
        !(item.repository_id === null || positive(item.repository_id)) ||
        !(
          item.status_code === null ||
          item.status_code === 0 ||
          (Number.isSafeInteger(item.status_code) &&
            (item.status_code as number) >= 100 &&
            (item.status_code as number) <= 599)
        )
      )
        throw new Error('Invalid GitHub delivery metadata')
      const id = deliveryId(item.id),
        deliveredAt = Date.parse(item.delivered_at)
      if (
        seen.has(id) ||
        !Number.isSafeInteger(deliveredAt) ||
        deliveredAt < 0 ||
        new Date(deliveredAt).toISOString().slice(0, 19) !== item.delivered_at.slice(0, 19)
      )
        throw new Error('Invalid GitHub delivery identity or time')
      seen.add(id)
      return {
        id,
        guid: item.guid.toLowerCase(),
        deliveredAt,
        statusCode: item.status_code as number | null,
        event: item.event,
        action: item.action as string | null,
        installationId: item.installation_id as number | null,
        repositoryId: item.repository_id as number | null,
      }
    })
  return { deliveries, cursor }
}
