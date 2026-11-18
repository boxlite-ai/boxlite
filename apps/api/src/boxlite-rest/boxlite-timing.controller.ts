/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, Header, NotFoundException, Param, UseGuards } from '@nestjs/common'
import { ApiBearerAuth } from '@nestjs/swagger'
import axios from 'axios'
import { CombinedAuthGuard } from '../auth/combined-auth.guard'
import { BoxService } from '../box/services/box.service'
import { RunnerService } from '../box/services/runner.service'
import { AuthContext } from '../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../common/interfaces/auth-context.interface'
import { snapshotTiming, TimingEvent } from '../common/utils/tti-timing.util'
import { OrganizationResourceActionGuard } from '../organization/guards/organization-resource-action.guard'

type RunnerStatus = 'ok' | 'unavailable' | 'timeout' | 'auth_error' | 'no_runner'
type RunnerTiming = { runner: TimingEvent[]; runner_status: RunnerStatus }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseRunnerTiming(data: unknown, boxId: string): TimingEvent[] | undefined {
  if (!isRecord(data) || data.box_id !== boxId || !Array.isArray(data.events)) return

  const events: TimingEvent[] = []
  for (const event of data.events) {
    if (!isRecord(event)) return
    const { op, stage, status, dur_ms, ts } = event
    if (
      typeof op !== 'string' ||
      typeof stage !== 'string' ||
      (status !== 'ok' && status !== 'error' && status !== 'skipped') ||
      typeof dur_ms !== 'number' ||
      !Number.isFinite(dur_ms) ||
      typeof ts !== 'string'
    ) {
      return
    }
    const parsed: TimingEvent = { op, stage, status, dur_ms, ts }
    for (const key of ['box_id', 'job_id', 'exec_id'] as const) {
      const id = event[key]
      if (id === '' || id === null || id === undefined) continue
      if (typeof id !== 'string' || (key === 'box_id' && id !== boxId)) return
      parsed[key] = id
    }
    events.push(parsed)
  }
  return events
}

@Controller('timing')
@UseGuards(CombinedAuthGuard, OrganizationResourceActionGuard)
@ApiBearerAuth()
export class BoxliteTimingController {
  constructor(
    private readonly boxService: BoxService,
    private readonly runnerService: RunnerService,
  ) {}

  @Get(':box_id')
  @Header('Cache-Control', 'no-store')
  async getTiming(
    @AuthContext() authContext: OrganizationAuthContext,
    @Param('box_id') boxId: string,
  ): Promise<{ box_id: string; api: TimingEvent[] } & RunnerTiming> {
    const box = await this.boxService.findByIdForTiming(boxId, authContext.organizationId)
    if (!box) throw new NotFoundException()

    const api = snapshotTiming(box.id)
    return { box_id: box.id, api, ...(await this.getRunnerTiming(box.id, box.runnerId || box.prevRunnerId)) }
  }

  private async getRunnerTiming(boxId: string, runnerId?: string): Promise<RunnerTiming> {
    if (!runnerId) return { runner: [], runner_status: 'no_runner' }

    try {
      const runner = await this.runnerService.findOne(runnerId)
      if (!runner) return { runner: [], runner_status: 'unavailable' }
      const url = runner.apiUrl || runner.proxyUrl
      if (!url) return { runner: [], runner_status: 'unavailable' }

      const { data } = await axios.get<unknown>(`${url.replace(/\/+$/, '')}/timing/${encodeURIComponent(boxId)}`, {
        headers: { Authorization: `Bearer ${runner.apiKey}` },
        timeout: 3000,
        maxRedirects: 0,
      })
      const events = parseRunnerTiming(data, boxId)
      if (events) return { runner: events, runner_status: 'ok' }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401 || error.response?.status === 403) {
          return { runner: [], runner_status: 'auth_error' }
        }
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
          return { runner: [], runner_status: 'timeout' }
        }
      }
    }
    return { runner: [], runner_status: 'unavailable' }
  }
}
