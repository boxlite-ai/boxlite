/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { UserService } from '../../user/user.service'
import { RunnerService } from '../../sandbox/services/runner.service'
import { SandboxRepository } from '../../sandbox/repositories/sandbox.repository'
import { RunnerState } from '../../sandbox/enums/runner-state.enum'
import { SandboxState } from '../../sandbox/enums/sandbox-state.enum'
import {
  AdminBoxItemDto,
  AdminMachineItemDto,
  AdminOverviewDto,
  AdminRunnerItemDto,
  AdminUserItemDto,
} from '../dto/admin-overview.dto'

// Large enough to fetch all draining runners in one call without adding a new
// service method — the draining set is always a small subset of runners.
const ALL_DRAINING_TAKE = 10_000

@Injectable()
export class AdminOverviewService {
  constructor(
    private readonly userService: UserService,
    private readonly runnerService: RunnerService,
    private readonly sandboxRepository: SandboxRepository,
  ) {}

  async getOverview(): Promise<AdminOverviewDto> {
    const [users, runners, startedSandboxes, drainingRunners] = await Promise.all([
      this.userService.findAll(),
      this.runnerService.findAllFull(),
      this.sandboxRepository.find({ where: { state: SandboxState.STARTED } }),
      this.runnerService.findDrainingPaginated(0, ALL_DRAINING_TAKE),
    ])

    const onlineCount = runners.filter((r) => r.state === RunnerState.READY).length
    const drainingCount = drainingRunners.length

    const totalCpu = runners.reduce((sum, r) => sum + r.cpu, 0)
    const totalAllocated = runners.reduce((sum, r) => sum + r.currentAllocatedCpu, 0)
    const avgCpuUtil =
      runners.length > 0 ? runners.reduce((sum, r) => sum + r.currentCpuUsagePercentage, 0) / runners.length / 100 : 0
    const oversell = totalCpu > 0 ? totalAllocated / totalCpu : 0

    return {
      users: users.length,
      activeBoxes: startedSandboxes.length,
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
    const sandboxes = await this.sandboxRepository.find()
    return sandboxes.map((s) => ({
      id: s.id,
      organizationId: s.organizationId,
      state: s.state,
      runnerId: s.runnerId,
      cpu: s.cpu,
      memoryGiB: s.mem,
      createdAt: s.createdAt.toISOString(),
    }))
  }

  async listRunners(): Promise<AdminRunnerItemDto[]> {
    const [runners, drainingRunners] = await Promise.all([
      this.runnerService.findAllFull(),
      this.runnerService.findDrainingPaginated(0, ALL_DRAINING_TAKE),
    ])

    const drainingIds = new Set(drainingRunners.map((r) => r.id))

    return runners.map((r) => ({
      ...r,
      draining: drainingIds.has(r.id),
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
    currentStartedSandboxes: number
  }): AdminMachineItemDto {
    // Guard divide-by-zero: if runner has no cpu capacity, oversell = 0
    const oversellCpu = r.cpu > 0 ? r.currentAllocatedCpu / r.cpu : 0
    return {
      host: r.id,
      region: r.region,
      oversellCpu,
      cpuWaterline: r.currentCpuUsagePercentage,
      memWaterline: r.currentMemoryUsagePercentage,
      sandboxes: r.currentStartedSandboxes,
    }
  }
}
