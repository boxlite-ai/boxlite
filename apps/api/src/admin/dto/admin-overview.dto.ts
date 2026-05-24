/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { RunnerFullDto } from '../../sandbox/dto/runner-full.dto'
import { SystemRole } from '../../user/enums/system-role.enum'
import { SandboxState } from '../../sandbox/enums/sandbox-state.enum'

// ─── KPI summary ────────────────────────────────────────────────────────────

@ApiSchema({ name: 'AdminOverviewRunners' })
export class AdminOverviewRunnersDto {
  @ApiProperty({ description: 'Number of online (ready) runners', example: 3 })
  online: number

  @ApiProperty({ description: 'Total number of runners', example: 5 })
  total: number

  @ApiProperty({ description: 'Number of draining runners', example: 1 })
  draining: number
}

@ApiSchema({ name: 'AdminOverviewCluster' })
export class AdminOverviewClusterDto {
  @ApiProperty({ description: 'Average CPU utilisation across all runners (0–1)', example: 0.42 })
  cpuUtil: number

  @ApiProperty({ description: 'Average CPU oversell ratio (allocated / capacity); 0 when no capacity', example: 1.1 })
  oversell: number
}

@ApiSchema({ name: 'AdminOverviewBoxes' })
export class AdminOverviewBoxesDto {
  @ApiProperty({ description: 'Total number of sandboxes across all states', example: 80 })
  total: number

  @ApiProperty({
    description: 'Sandbox counts keyed by SandboxState',
    example: { started: 15, error: 2, build_failed: 1, stopped: 62 },
    additionalProperties: { type: 'number' },
  })
  byState: Record<string, number>
}

@ApiSchema({ name: 'AdminOverview' })
export class AdminOverviewDto {
  @ApiProperty({ description: 'Total number of users', example: 120 })
  users: number

  @ApiProperty({ description: 'Number of active (started) sandboxes', example: 47 })
  activeBoxes: number

  @ApiProperty({ type: AdminOverviewBoxesDto })
  boxes: AdminOverviewBoxesDto

  @ApiProperty({ type: AdminOverviewRunnersDto })
  runners: AdminOverviewRunnersDto

  @ApiProperty({ type: AdminOverviewClusterDto })
  cluster: AdminOverviewClusterDto
}

// ─── User list ───────────────────────────────────────────────────────────────

@ApiSchema({ name: 'AdminUserItem' })
export class AdminUserItemDto {
  @ApiProperty({ description: 'User ID', example: 'usr_abc123' })
  id: string

  @ApiProperty({ description: 'User email', example: 'alice@example.com' })
  email: string

  @ApiProperty({ description: 'Display name', example: 'Alice Smith' })
  name: string

  @ApiProperty({ enum: SystemRole, enumName: 'SystemRole', example: SystemRole.USER })
  role: SystemRole
}

// ─── Sandbox list ────────────────────────────────────────────────────────────

@ApiSchema({ name: 'AdminBoxOwner' })
export class AdminBoxOwnerDto {
  @ApiProperty({ description: 'Display name for the owner group', example: 'Alice Smith' })
  name: string

  @ApiProperty({ description: 'Owner email for personal organizations, blank when unavailable', example: 'alice@example.com' })
  email: string

  @ApiProperty({ description: 'Organization name backing this box', example: 'Alice Personal' })
  orgName: string

  @ApiProperty({ description: 'Whether this is a personal organization', example: true })
  personal: boolean
}

@ApiSchema({ name: 'AdminBoxItem' })
export class AdminBoxItemDto {
  @ApiProperty({ description: 'Sandbox ID', example: 'sb_abc123' })
  id: string

  @ApiProperty({ description: 'Organization ID', example: 'org_xyz' })
  organizationId: string

  @ApiProperty({ enum: SandboxState, enumName: 'SandboxState', example: SandboxState.STARTED })
  state: SandboxState

  @ApiPropertyOptional({ description: 'Runner ID the sandbox is assigned to', example: 'runner-uuid' })
  runnerId?: string

  @ApiProperty({ description: 'Allocated CPU (vCPUs)', example: 2 })
  cpu: number

  @ApiPropertyOptional({ description: 'Allocated memory in GiB', example: 4 })
  memoryGiB?: number

  @ApiProperty({ description: 'Creation timestamp', example: '2024-01-01T00:00:00Z' })
  createdAt: string

  @ApiProperty({ type: AdminBoxOwnerDto })
  owner: AdminBoxOwnerDto
}

// ─── Runner admin item (RunnerFullDto + draining flag) ───────────────────────

@ApiSchema({ name: 'AdminRunnerItem' })
export class AdminRunnerItemDto extends RunnerFullDto {
  @ApiProperty({ description: 'Whether the runner is currently draining', example: false })
  draining: boolean
}

// ─── Machine (runner-as-machine) view ────────────────────────────────────────

@ApiSchema({ name: 'AdminMachineItem' })
export class AdminMachineItemDto {
  @ApiProperty({ description: 'Runner / host ID', example: 'runner-uuid' })
  host: string

  @ApiProperty({ description: 'Region ID', example: 'us-east-1' })
  region: string

  @ApiProperty({ description: 'CPU oversell ratio (allocatedCpu / totalCpu); 0 when capacity is 0', example: 0.75 })
  oversellCpu: number

  @ApiProperty({ description: 'CPU utilisation waterline (0–100)', example: 45.6 })
  cpuWaterline: number

  @ApiProperty({ description: 'Memory utilisation waterline (0–100)', example: 68.2 })
  memWaterline: number

  @ApiProperty({ description: 'Number of currently started sandboxes on this runner', example: 5 })
  sandboxes: number
}
