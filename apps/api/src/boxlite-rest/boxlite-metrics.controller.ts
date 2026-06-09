/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { Sandbox } from '../sandbox/entities/sandbox.entity'
import { SandboxState } from '../sandbox/enums/sandbox-state.enum'

/**
 * Org-scoped runtime counters returned by `GET /v1/{prefix}/metrics`.
 *
 * Field shape mirrors the SDK's `RuntimeMetricsResponse` (see
 * `src/boxlite/src/rest/types.rs`) — DO NOT rename fields without
 * updating the SDK in lock-step, otherwise serde will drop them
 * silently on the other side.
 *
 * Counters are aggregated lazily from the sandbox table. This is
 * intentionally a "best-effort snapshot" rather than a streaming
 * Prometheus-style counter — the SDK's MetricsRegistry treats it as
 * a point-in-time read.
 */
class RuntimeMetricsResponseDto {
  boxes_created_total: number
  boxes_failed_total: number
  boxes_stopped_total: number
  num_running_boxes: number
  // Per-runtime exec counters require a join against a separate
  // execution log table that the API does not own today. Return zero
  // for now; the SDK MetricsRegistry tolerates missing/zero values
  // because `#[serde(default)]` is set on every field.
  total_commands_executed: number
  total_exec_errors: number
}

@ApiTags('BoxLite REST')
@Controller('v1/:prefix')
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
@ApiBearerAuth()
export class BoxliteMetricsController {
  constructor(
    @InjectRepository(Sandbox)
    private readonly sandboxRepository: Repository<Sandbox>,
  ) {}

  @Get('metrics')
  async getMetrics(@AuthContext() ctx: OrganizationAuthContext): Promise<RuntimeMetricsResponseDto> {
    const orgId = ctx.organizationId

    // Aggregating with one count() per state would issue N queries;
    // group-by gives us the full breakdown in a single round trip.
    const rows = await this.sandboxRepository
      .createQueryBuilder('s')
      .select('s.state', 'state')
      .addSelect('COUNT(*)', 'count')
      .where('s.organizationId = :orgId', { orgId })
      .groupBy('s.state')
      .getRawMany<{ state: string; count: string }>()

    const byState = new Map<string, number>()
    let total = 0
    for (const row of rows) {
      const n = parseInt(row.count, 10) || 0
      byState.set(row.state, n)
      total += n
    }

    const running = byState.get(SandboxState.STARTED) ?? 0
    const stopped = byState.get(SandboxState.STOPPED) ?? 0
    const errored = byState.get(SandboxState.ERROR) ?? 0

    return {
      // boxes_created_total = lifetime creates ≈ current rows in the
      // sandbox table (rows survive destroy as soft-deleted). For a
      // hard-deleted history we'd need a separate audit table; this
      // approximation is good enough for the SDK's
      // "did the counter tick after I created a box" assertion.
      boxes_created_total: total,
      boxes_failed_total: errored,
      boxes_stopped_total: stopped,
      num_running_boxes: running,
      total_commands_executed: 0,
      total_exec_errors: 0,
    }
  }
}
