/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { UserService } from '../../user/user.service'
import { RunnerService } from '../../box/services/runner.service'
import { BoxRepository } from '../../box/repositories/box.repository'
import { RunnerState } from '../../box/enums/runner-state.enum'
import { BoxState } from '../../box/enums/box-state.enum'
import { OrganizationService } from '../../organization/services/organization.service'
import {
  AdminBoxOwnerDto,
  AdminBoxItemDto,
  AdminMachineItemDto,
  AdminOverviewDto,
  AdminRunnerDto,
  AdminRunnerItemDto,
  AdminUserItemDto,
} from '../dto/admin-overview.dto'

// Large enough to fetch all draining runners in one call without adding a new
// service method — the draining set is always a small subset of runners.
const ALL_DRAINING_TAKE = 10_000

type BoxStateCountRow = {
  state: BoxState
  count: string | number
}

type BoxWithOwnerInput = {
  organizationId: string
}

@Injectable()
export class AdminOverviewService {
  constructor(
    private readonly userService: UserService,
    private readonly runnerService: RunnerService,
    private readonly boxRepository: BoxRepository,
    private readonly organizationService: OrganizationService,
  ) {}

  async getOverview(): Promise<AdminOverviewDto> {
    const [users, runners, boxes, drainingRunners] = await Promise.all([
      this.userService.findAll(),
      this.runnerService.findAllFull(),
      this.getBoxStateBreakdown(),
      this.runnerService.findDrainingPaginated(0, ALL_DRAINING_TAKE),
    ])

    const onlineRunners = runners.filter((r) => r.state === RunnerState.READY)
    const onlineCount = onlineRunners.length
    const drainingCount = drainingRunners.length

    const totalCpu = runners.reduce((sum, r) => sum + r.cpu, 0)
    const totalAllocated = runners.reduce((sum, r) => sum + r.currentAllocatedCpu, 0)
    // Utilisation reflects live load → average over online (READY) runners only;
    // unresponsive runners report 0% and would otherwise dilute the figure to ~0.
    const avgCpuUtil =
      onlineRunners.length > 0
        ? onlineRunners.reduce((sum, r) => sum + r.currentCpuUsagePercentage, 0) / onlineRunners.length / 100
        : 0
    const oversell = totalCpu > 0 ? totalAllocated / totalCpu : 0

    return {
      users: users.length,
      activeBoxes: boxes.byState[BoxState.STARTED] ?? 0,
      boxes,
      runners: {
        online: onlineCount,
        total: runners.length,
        draining: drainingCount,
      },
      cluster: {
        cpuUtil: avgCpuUtil,
        oversell,
      },
    }
  }

  private async getBoxStateBreakdown() {
    const rows = await this.boxRepository
      .createQueryBuilder('box')
      .select('box.state', 'state')
      .addSelect('COUNT(*)', 'count')
      .groupBy('box.state')
      .getRawMany<BoxStateCountRow>()

    const byState = rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.state] = Number(row.count)
      return acc
    }, {})

    return {
      total: Object.values(byState).reduce((sum, count) => sum + count, 0),
      byState,
    }
  }

  async listUsers(): Promise<AdminUserItemDto[]> {
    const users = await this.userService.findAll()
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
    }))
  }

  async listBoxes(): Promise<AdminBoxItemDto[]> {
    const boxes = await this.boxRepository.find()
    const ownersByOrganizationId = await this.resolveBoxOwners(boxes)

    return boxes.map((s) => ({
      id: s.id,
      boxId: s.boxId,
      organizationId: s.organizationId,
      state: s.state,
      runnerId: s.runnerId,
      cpu: s.cpu,
      memoryGiB: s.mem,
      createdAt: s.createdAt.toISOString(),
      owner: ownersByOrganizationId.get(s.organizationId) ?? this.fallbackBoxOwner(s.organizationId),
    }))
  }

  private async resolveBoxOwners(boxes: BoxWithOwnerInput[]): Promise<Map<string, AdminBoxOwnerDto>> {
    const organizationIds = Array.from(new Set(boxes.map((box) => box.organizationId).filter(Boolean)))
    const organizations = await this.organizationService.findByIds(organizationIds)
    const creatorIds = Array.from(new Set(organizations.map((organization) => organization.createdBy).filter(Boolean)))
    const users = await this.userService.findByIds(creatorIds)
    const usersById = new Map(users.map((user) => [user.id, user]))

    return new Map(
      organizations.map((organization) => [
        organization.id,
        this.toBoxOwner(organization, usersById.get(organization.createdBy)),
      ]),
    )
  }

  private toBoxOwner(
    // NOTE(integration 2026-06-08): default-organization-membership removed the
    // Organization.personal column — "personal" is now a per-authenticated-user alias,
    // not an org attribute. Admin overview has no authenticated-user context, so it cannot
    // resolve personal-ness per org; present every org org-style. Revisit if admin needs to
    // flag default/personal orgs (would require a membership lookup).
    organization: { createdBy?: string; name: string },
    creator?: { name: string; email: string },
  ): AdminBoxOwnerDto {
    return {
      userId: organization.createdBy,
      name: organization.name,
      email: creator?.email ?? '',
      orgName: organization.name,
      personal: false,
    }
  }

  private fallbackBoxOwner(organizationId: string): AdminBoxOwnerDto {
    return {
      name: organizationId,
      email: '',
      orgName: organizationId,
      personal: false,
    }
  }

  async listRunners(): Promise<AdminRunnerItemDto[]> {
    const [runners, drainingRunners] = await Promise.all([
      this.runnerService.findAllFull(),
      this.runnerService.findDrainingPaginated(0, ALL_DRAINING_TAKE),
    ])

    const drainingIds = new Set(drainingRunners.map((r) => r.id))

    return runners.map((runner) => ({
      ...this.toAdminRunnerItem(runner),
      draining: drainingIds.has(runner.id),
    }))
  }

  async listMachines(): Promise<AdminMachineItemDto[]> {
    const runners = await this.runnerService.findAllFull()
    return runners.map((r) => this.toMachineDto(r))
  }

  private toMachineDto(r: {
    id: string
    region: string
    cpu: number
    currentAllocatedCpu: number
    currentCpuUsagePercentage: number
    currentMemoryUsagePercentage: number
    currentStartedBoxes: number
  }): AdminMachineItemDto {
    // Guard divide-by-zero: if runner has no cpu capacity, oversell = 0
    const oversellCpu = r.cpu > 0 ? r.currentAllocatedCpu / r.cpu : 0
    return {
      host: r.id,
      region: r.region,
      oversellCpu,
      cpuWaterline: r.currentCpuUsagePercentage,
      memWaterline: r.currentMemoryUsagePercentage,
      boxes: r.currentStartedBoxes,
    }
  }

  private toAdminRunnerItem(runner: AdminRunnerDto & { apiKey?: string }): AdminRunnerDto {
    const { apiKey: _apiKey, ...safeRunner } = runner
    return safeRunner
  }
}
