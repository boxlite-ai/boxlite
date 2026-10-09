/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { InjectRedis } from '@nestjs-modules/ioredis'
import Redis from 'ioredis'
import { DataSource, EntityManager } from 'typeorm'
import { apiKeyValidationCacheKey } from '../common/utils/api-key'
import { OrganizationMemberRole } from '../organization/enums/organization-member-role.enum'
import { User } from './user.entity'

interface Membership {
  organizationId: string
  role: OrganizationMemberRole
  isDefaultForUser: boolean
}

/**
 * Local bookkeeping for an identity Auth0 is about to fold into a primary
 * account (POL-555). It runs before the tenant link, so that a link which
 * then fails leaves a state the next login can simply repeat.
 *
 * BoxLite provisions a user, and a default organization, from the token
 * subject the first time it sees one. Once Auth0 links one account into
 * another, tokens stop carrying the folded account's subject, and every
 * organization that subject belonged to would stop appearing: the membership
 * rows still name the old id. This moves them to the primary account.
 *
 * Boxes, volumes and usage belong to organizations, not users, so none of them
 * move. The old user row stays: nothing reads it once its memberships and keys
 * are gone, and deleting it would buy nothing but a failure mode.
 */
@Injectable()
export class LinkedIdentityService {
  private readonly logger = new Logger(LinkedIdentityService.name)

  constructor(
    private readonly dataSource: DataSource,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  /**
   * Hand everything `secondaryUserId` owns locally to `primaryUserId`.
   *
   * Safe to repeat: once the secondary owns nothing, a second call moves
   * nothing.
   */
  async adopt(primaryUserId: string, secondaryUserId: string): Promise<void> {
    if (primaryUserId === secondaryUserId) {
      throw new Error(`cannot link ${primaryUserId} to itself`)
    }

    const movedKeyHashes = await this.dataSource.transaction(async (em) => {
      // Serialise concurrent adoptions of one secondary, so two links
      // racing over the same identity cannot both copy its memberships.
      const secondary = await em
        .createQueryBuilder(User, 'user')
        .setLock('pessimistic_write')
        .where('user.id = :id', { id: secondaryUserId })
        .getOne()
      if (!secondary) {
        return []
      }

      await this.ensurePrimaryUser(em, primaryUserId, secondary)
      const moved = await this.moveMemberships(em, primaryUserId, secondaryUserId)
      const keyHashes = await this.moveApiKeys(em, primaryUserId, secondaryUserId)
      await em.query(`UPDATE "organization" SET "createdBy" = $1 WHERE "createdBy" = $2`, [
        primaryUserId,
        secondaryUserId,
      ])

      this.logger.log(
        `Moved ${moved} membership(s) and ${keyHashes.length} API key(s) from ${secondaryUserId} to ${primaryUserId}`,
      )
      return keyHashes
    })
    await this.forgetCachedOwners(movedKeyHashes)
  }

  /**
   * ApiKeyStrategy caches a validated key with its owner for a few seconds.
   * Until that entry goes, a moved key keeps authenticating as the secondary,
   * which no longer belongs to any organization. Dropped after the move
   * commits: any earlier, a request could read the old owner from the
   * database and cache it again.
   */
  private async forgetCachedOwners(keyHashes: string[]): Promise<void> {
    if (keyHashes.length === 0) {
      return
    }
    try {
      await this.redis.del(...keyHashes.map(apiKeyValidationCacheKey))
    } catch (error) {
      // The entries expire on their own; the move has committed and stands.
      this.logger.error('Could not drop moved API keys from the validation cache:', error)
    }
  }

  /**
   * A primary account BoxLite has never seen gets the secondary's profile.
   *
   * Created here rather than on its first token because that path always
   * creates a fresh default organization: the person would arrive with two,
   * one of them empty, when the organization they have been using is the one
   * that should stay their default.
   */
  private async ensurePrimaryUser(em: EntityManager, primaryUserId: string, secondary: User): Promise<void> {
    const existing = await em.findOne(User, { where: { id: primaryUserId } })
    if (existing) {
      return
    }
    await em.insert(User, {
      id: primaryUserId,
      name: secondary.name,
      email: secondary.email,
      emailVerified: secondary.emailVerified,
      keyPair: secondary.keyPair,
      publicKeys: secondary.publicKeys,
      role: secondary.role,
    })
  }

  private async moveMemberships(em: EntityManager, primaryUserId: string, secondaryUserId: string): Promise<number> {
    const incoming: Membership[] = await em.query(
      `SELECT "organizationId", "role", "isDefaultForUser" FROM "organization_user" WHERE "userId" = $1`,
      [secondaryUserId],
    )
    if (incoming.length === 0) {
      return 0
    }
    const existing: Membership[] = await em.query(
      `SELECT "organizationId", "role", "isDefaultForUser" FROM "organization_user" WHERE "userId" = $1`,
      [primaryUserId],
    )
    const existingByOrganization = new Map(existing.map((row) => [row.organizationId, row]))
    // One default per user is enforced by a partial unique index. The
    // primary's own default wins; the secondary's only survives when the
    // primary had none, which is a primary BoxLite had not seen before.
    let hasDefault = existing.some((row) => row.isDefaultForUser)

    for (const membership of incoming) {
      const shared = existingByOrganization.get(membership.organizationId)
      if (shared) {
        if (shared.role !== OrganizationMemberRole.OWNER && membership.role === OrganizationMemberRole.OWNER) {
          await em.query(`UPDATE "organization_user" SET "role" = $1 WHERE "organizationId" = $2 AND "userId" = $3`, [
            OrganizationMemberRole.OWNER,
            membership.organizationId,
            primaryUserId,
          ])
        }
      } else {
        const isDefault = membership.isDefaultForUser && !hasDefault
        hasDefault ||= isDefault
        await em.query(
          `INSERT INTO "organization_user" ("organizationId", "userId", "role", "isDefaultForUser", "createdAt", "updatedAt")
           SELECT "organizationId", $1, "role", $2, "createdAt", now() FROM "organization_user"
           WHERE "organizationId" = $3 AND "userId" = $4`,
          [primaryUserId, isDefault, membership.organizationId, secondaryUserId],
        )
      }
      // Copy before the delete below cascades the secondary's assignments away.
      await em.query(
        `INSERT INTO "organization_role_assignment" ("organizationId", "userId", "roleId")
         SELECT "organizationId", $1, "roleId" FROM "organization_role_assignment"
         WHERE "organizationId" = $2 AND "userId" = $3
         ON CONFLICT DO NOTHING`,
        [primaryUserId, membership.organizationId, secondaryUserId],
      )
      await em.query(`DELETE FROM "organization_user" WHERE "organizationId" = $1 AND "userId" = $2`, [
        membership.organizationId,
        secondaryUserId,
      ])
    }
    return incoming.length
  }

  /**
   * Keys resolve their owner through the user row, so a key left on the
   * secondary would authenticate a user who is no longer a member anywhere.
   *
   * A key's name is unique per user within an organization. When both
   * accounts named a key the same in one organization, the moved key keeps
   * working under the secondary's provider as a suffix, numbered when the
   * primary holds that name too, rather than one of them being dropped.
   *
   * Returns the moved keys' hashes.
   */
  private async moveApiKeys(em: EntityManager, primaryUserId: string, secondaryUserId: string): Promise<string[]> {
    const provider = secondaryUserId.slice(0, secondaryUserId.indexOf('|'))
    const keys: { organizationId: string; userId: string; name: string; keyHash: string }[] = await em.query(
      `SELECT "organizationId", "userId", "name", "keyHash" FROM "api_key" WHERE "userId" IN ($1, $2)`,
      [primaryUserId, secondaryUserId],
    )
    const slot = (organizationId: string, name: string) => `${organizationId}/${name}`
    const held = new Set(
      keys.filter((key) => key.userId === primaryUserId).map((key) => slot(key.organizationId, key.name)),
    )
    const incoming = keys.filter((key) => key.userId === secondaryUserId)
    // Every moved key that keeps its name holds it before a renamed key picks one.
    const taken = new Set([...held, ...incoming.map((key) => slot(key.organizationId, key.name))])

    for (const key of incoming) {
      let name = key.name
      if (held.has(slot(key.organizationId, name))) {
        name = `${key.name} (${provider})`
        for (let n = 2; taken.has(slot(key.organizationId, name)); n++) {
          name = `${key.name} (${provider} ${n})`
        }
        taken.add(slot(key.organizationId, name))
      }
      await em.query(
        `UPDATE "api_key" SET "userId" = $1, "name" = $2 WHERE "organizationId" = $3 AND "userId" = $4 AND "name" = $5`,
        [primaryUserId, name, key.organizationId, secondaryUserId, key.name],
      )
    }
    return incoming.map((key) => key.keyHash)
  }
}
