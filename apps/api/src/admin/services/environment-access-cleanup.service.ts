/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { MoreThan, Repository } from 'typeorm'
import { ApiKeyService } from '../../api-key/api-key.service'
import { OrganizationUser } from '../../organization/entities/organization-user.entity'
import { OrganizationMemberRole } from '../../organization/enums/organization-member-role.enum'
import { OrganizationService } from '../../organization/services/organization.service'
import { OrganizationUserService } from '../../organization/services/organization-user.service'
import { BoxService } from '../../box/services/box.service'
import { BoxState } from '../../box/enums/box-state.enum'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { Context } from '../../common/context/context'

type CleanupAction = 'leave' | 'suspend' | 'none'
export type AccessOrganization = { organizationId: string; name: string; action: CleanupAction }
export type AccessCleanup = {
  complete: boolean
  apiKeys: { deleted: number; complete: boolean }
  organizations: Array<AccessOrganization & { status: 'completed' | 'failed'; errorCode?: string }>
  boxes: Array<{ boxId: string; organizationId: string; status: 'requested' | 'already_requested' | 'failed' }>
  errorCode?: string
}

function actionFor(member: OrganizationUser): CleanupAction {
  if (
    member.isDefaultForUser &&
    member.role === OrganizationMemberRole.OWNER &&
    member.organization.createdBy === member.userId
  )
    return 'suspend'
  if (
    !member.isDefaultForUser &&
    (member.role !== OrganizationMemberRole.OWNER || member.organization.createdBy !== member.userId)
  )
    return 'leave'
  return 'none'
}

@Injectable()
export class EnvironmentAccessCleanupService {
  constructor(
    @InjectRepository(OrganizationUser) private readonly memberships: Repository<OrganizationUser>,
    private readonly members: OrganizationUserService,
    private readonly organizations: OrganizationService,
    private readonly keys: ApiKeyService,
    private readonly boxes: BoxService,
  ) {}

  async describe(userId: string) {
    const members = await this.page(userId, undefined, 201)
    return {
      organizations: members.slice(0, 200).map(
        (member): AccessOrganization => ({
          organizationId: member.organizationId,
          name: member.organization.name,
          action: actionFor(member),
        }),
      ),
      truncated: members.length > 200,
    }
  }

  async revoke(userId: string, context: Context): Promise<AccessCleanup> {
    const deadline = Date.now() + 20_000
    const apiKeys = await this.keys.revokeUserKeys(userId, deadline)
    const result: AccessCleanup = { complete: apiKeys.complete, apiKeys, organizations: [], boxes: [] }
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      if (Date.now() >= deadline) return { ...result, complete: false, errorCode: 'cleanup_timeout' }
      let members: OrganizationUser[]
      try {
        members = await this.page(userId, cursor, 100)
      } catch {
        return { ...result, complete: false, errorCode: 'membership_scan_failed' }
      }
      if (!members.length) return result
      // Advance through failed and retained memberships as well as deleted ones.
      cursor = members[members.length - 1].organizationId
      for (const member of members) {
        if (Date.now() >= deadline) return { ...result, complete: false, errorCode: 'cleanup_timeout' }
        const action = actionFor(member)
        if (action === 'none') continue
        const outcome: AccessCleanup['organizations'][number] = {
          organizationId: member.organizationId,
          name: member.organization.name,
          action,
          status: 'completed',
        }
        try {
          if (action === 'leave') {
            // Preserve default/last-Owner checks and transactional revocation events.
            await this.members.delete(member.organizationId, userId)
          } else if (!member.organization.suspended || member.organization.suspendedUntil) {
            // Repeated revoke must not postpone an existing suspension's cleanup deadline.
            await this.organizations.suspend(member.organizationId, 'Environment access revoked')
          }
        } catch {
          outcome.status = 'failed'
          outcome.errorCode = action === 'leave' ? 'membership_removal_failed' : 'organization_suspend_failed'
          result.complete = false
        }
        result.organizations.push(outcome)
        if (action === 'suspend' && outcome.status === 'completed') {
          await this.stopBoxes(member.organizationId, result, context, deadline)
        }
      }
    }
    return { ...result, complete: false, errorCode: 'membership_limit_reached' }
  }

  private async stopBoxes(organizationId: string, result: AccessCleanup, context: Context, deadline: number) {
    try {
      const targets = new Map<string, { id: string; desiredState: BoxDesiredState }>()
      // Capture IDs before submitting stops: lifecycle changes can shrink offset pages.
      for (let page = 1; page <= 20; page++) {
        if (Date.now() >= deadline) throw new Error('timeout')
        const boxes = await this.boxes.findAll(organizationId, page, 100, { states: [BoxState.STARTED] })
        for (const box of boxes.items) targets.set(box.id, box)
        if (page >= boxes.totalPages) break
        if (page === 20) {
          result.complete = false
          result.errorCode = 'box_scan_limit_reached'
        }
      }
      for (const box of targets.values()) {
        if (Date.now() >= deadline) throw new Error('timeout')
        let status: AccessCleanup['boxes'][number]['status'] = 'already_requested'
        if (box.desiredState !== BoxDesiredState.STOPPED) {
          try {
            await this.boxes.stop(box.id, organizationId, context, false, 'id')
            status = 'requested'
          } catch {
            status = 'failed'
            result.complete = false
          }
        }
        result.boxes.push({ boxId: box.id, organizationId, status })
      }
    } catch {
      result.complete = false
      result.errorCode = 'box_stop_incomplete'
    }
  }

  private page(userId: string, cursor: string | undefined, take: number) {
    return this.memberships.find({
      where: { userId, ...(cursor ? { organizationId: MoreThan(cursor) } : {}) },
      relations: { organization: true },
      order: { organizationId: 'ASC' },
      take,
    })
  }
}
