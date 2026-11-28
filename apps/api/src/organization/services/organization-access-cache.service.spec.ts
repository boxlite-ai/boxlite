/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import {
  invalidateMembershipAccessCache,
  OrganizationAccessCache,
} from './organization-access-cache.service'
import { Organization } from '../entities/organization.entity'

class FakeRedis {
  readonly values = new Map<string, string>()
  readonly generations = new Map<string, number>()
  readonly expirations: Array<{ key: string; seconds: number }> = []

  async get(key: string): Promise<string | null> {
    const generation = this.generations.get(key)
    if (generation !== undefined) return generation.toString()
    return this.values.get(key) ?? null
  }

  async eval(_script: string, _keyCount: number, generationKey: string, valueKey: string, ...args: string[]) {
    if (args.length === 0) {
      this.generations.set(generationKey, (this.generations.get(generationKey) ?? 0) + 1)
      this.values.delete(valueKey)
      return 1
    }

    const [expectedGeneration, value, seconds] = args
    if ((this.generations.get(generationKey) ?? 0).toString() !== expectedGeneration) return 0
    this.values.set(valueKey, value)
    this.expirations.push({ key: valueKey, seconds: Number(seconds) })
    return 1
  }
}

describe('OrganizationAccessCache', () => {
  it('coalesces organization loads and returns independent objects with a 60-second TTL', async () => {
    const redis = new FakeRedis()
    const cache = new OrganizationAccessCache(redis as any)
    let release!: (value: Record<string, unknown>) => void
    const pending = new Promise<Record<string, unknown>>((resolve) => (release = resolve))
    const loader = jest.fn().mockReturnValue(pending)

    const first = cache.getOrganization('org-1', loader as any)
    const second = cache.getOrganization('org-1', loader as any)
    release({ id: 'org-1', suspended: false })
    const [left, right] = await Promise.all([first, second])

    expect(loader).toHaveBeenCalledTimes(1)
    expect(left).toEqual(right)
    expect(left).not.toBe(right)
    expect(left).toBeInstanceOf(Organization)
    expect(redis.expirations).toContainEqual({ key: 'organization:org-1', seconds: 60 })
  })

  it('does not write an old organization result after invalidation', async () => {
    const redis = new FakeRedis()
    const cache = new OrganizationAccessCache(redis as any)
    let release!: (value: Record<string, unknown>) => void
    const pending = new Promise<Record<string, unknown>>((resolve) => (release = resolve))
    const oldLoader = jest.fn().mockReturnValue(pending)

    const oldRead = cache.getOrganization('org-1', oldLoader as any)
    for (let attempt = 0; oldLoader.mock.calls.length === 0 && attempt < 10; attempt++) await Promise.resolve()
    await cache.invalidateOrganization('org-1')
    release({ id: 'org-1', suspended: false })
    await oldRead

    const current = await cache.getOrganization('org-1', async () => ({ id: 'org-1', suspended: true }) as any)

    expect(current).toMatchObject({ suspended: true })
    expect(redis.values.get('organization:org-1')).toContain('"suspended":true')
  })

  it('does not write an old membership result after invalidation', async () => {
    const redis = new FakeRedis()
    const cache = new OrganizationAccessCache(redis as any)
    let release!: (value: Record<string, unknown>) => void
    const pending = new Promise<Record<string, unknown>>((resolve) => (release = resolve))
    const oldLoader = jest.fn().mockReturnValue(pending)

    const oldRead = cache.getOrganizationUser('org-1', 'user-1', oldLoader as any)
    for (let attempt = 0; oldLoader.mock.calls.length === 0 && attempt < 10; attempt++) await Promise.resolve()
    await invalidateMembershipAccessCache(redis as any, 'org-1', 'user-1')
    release({ organizationId: 'org-1', userId: 'user-1', role: 'owner' })
    await oldRead

    const current = await cache.getOrganizationUser('org-1', 'user-1', async () => null)

    expect(current).toBeNull()
    expect(redis.values.has('organization-user:org-1:user-1')).toBe(false)
  })

  it('coalesces memberships by organization and user with a 10-second TTL', async () => {
    const redis = new FakeRedis()
    const cache = new OrganizationAccessCache(redis as any)
    let release!: (value: Record<string, unknown>) => void
    const pending = new Promise<Record<string, unknown>>((resolve) => (release = resolve))
    const loader = jest.fn().mockReturnValue(pending)

    const first = cache.getOrganizationUser('org-1', 'user-1', loader as any)
    const second = cache.getOrganizationUser('org-1', 'user-1', loader as any)
    const other = cache.getOrganizationUser('org-1', 'user-2', async () => ({ userId: 'user-2' }) as any)
    release({ organizationId: 'org-1', userId: 'user-1' })

    await Promise.all([first, second, other])
    expect(loader).toHaveBeenCalledTimes(1)
    expect(redis.expirations).toContainEqual({ key: 'organization-user:org-1:user-1', seconds: 10 })
  })
})
