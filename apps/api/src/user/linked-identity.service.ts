/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { DataSource, EntityManager } from 'typeorm'
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
 * subject the first time it sees one. Once Auth0 links a social identity into
 * the password account, tokens stop carrying the social subject, and every
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

  constructor(private readonly dataSource: DataSource) {}

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

    await this.dataSource.transaction(async (em) => {
      // Serialise concurrent adoptions of one secondary, so two callbacks
      // racing over the same identity cannot both copy its memberships.
      const secondary = await em
        .createQueryBuilder(User, 'user')
        .setLock('pessimistic_write')
        .where('user.id = :id', { id: secondaryUserId })
        .getOne()
      if (!secondary) {
        return
      }

      await this.ensurePrimaryUser(em, primaryUserId, secondary)
      const moved = await this.moveMemberships(em, primaryUserId, secondaryUserId)
      const keys = await this.moveApiKeys(em, primaryUserId, secondaryUserId)
      await em.query(`UPDATE "organization" SET "createdBy" = $1 WHERE "createdBy" = $2`, [
        primaryUserId,
        secondaryUserId,
      ])

      this.logger.log(`Moved ${moved} membership(s) and ${keys} API key(s) from ${secondaryUserId} to ${primaryUserId}`)
    })
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
    // primary had none, which is the account the social login created.
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
   * working under the secondary's provider as a suffix, rather than one of
   * them being dropped.
   */
  private async moveApiKeys(em: EntityManager, primaryUserId: string, secondaryUserId: string): Promise<number> {
    const provider = secondaryUserId.slice(0, secondaryUserId.indexOf('|'))
    // TypeORM answers an UPDATE with [rows, affectedCount].
    const [, movedCount]: [unknown[], number] = await em.query(
      // Typed parameters: $1 is both assigned and compared, and Postgres will
      // not deduce one type for it from those two positions on its own.
      `UPDATE "api_key" AS moved
       SET "userId" = $1::varchar,
           "name" = CASE WHEN EXISTS (
             SELECT 1 FROM "api_key" AS kept
             WHERE kept."organizationId" = moved."organizationId"
               AND kept."userId" = $1::varchar
               AND kept."name" = moved."name"
           ) THEN moved."name" || ' (' || $3::text || ')' ELSE moved."name" END
       WHERE moved."userId" = $2::varchar`,
      [primaryUserId, secondaryUserId, provider],
    )
    return movedCount
  }
}
