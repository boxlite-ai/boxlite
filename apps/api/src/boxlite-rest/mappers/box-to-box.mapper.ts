/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxDto } from '../../box/dto/box.dto'
import { BoxState } from '../../box/enums/box-state.enum'
import {
  AUTO_DELETE_DISABLED,
  DEFAULT_AUTO_PAUSE_SECONDS,
  DEFAULT_AUTO_RESUME,
} from '../../box/constants/box-lifecycle.constants'
import { BoxResponseDto } from '../dto/box-response.dto'
import { CreateBoxDto as RestCreateBoxDto } from '../dto/create-box.dto'
import { CreateBoxDto } from '../../box/dto/create-box.dto'

export function boxToBoxResponse(box: BoxDto): BoxResponseDto {
  return {
    box_id: box.id,
    name: box.name,
    status: mapState(box.state),
    created_at: box.createdAt || new Date().toISOString(),
    updated_at: box.updatedAt || new Date().toISOString(),
    image: box.image || '',
    cpus: box.cpu || 1,
    memory_mib: (box.memory || 1) * 1024,
    labels: box.labels || {},
    auto_pause: box.autoPause ?? DEFAULT_AUTO_PAUSE_SECONDS,
    auto_delete: box.autoDelete ?? AUTO_DELETE_DISABLED,
    auto_resume: box.autoResume ?? DEFAULT_AUTO_RESUME,
  }
}

export function createBoxToCreateBox(dto: RestCreateBoxDto, target?: string): CreateBoxDto {
  const createDto = new CreateBoxDto()
  createDto.name = dto.name
  createDto.image = dto.image
  createDto.user = dto.user
  createDto.env = dto.env
  createDto.cpu = dto.cpus
  createDto.memory = dto.memory_mib ? Math.ceil(dto.memory_mib / 1024) : undefined
  createDto.disk = dto.disk_size_gb
  createDto.target = target
  createDto.captureLogs = dto.capture_logs
  createDto.autoPause = dto.auto_pause
  createDto.autoDelete = dto.auto_delete
  createDto.autoResume = dto.auto_resume
  if (dto.network) {
    const allowNet = dto.network.allow_net?.map((entry) => entry.trim()).filter(Boolean)
    createDto.networkBlockAll = dto.network.mode === 'disabled'
    createDto.networkAllowList = dto.network.mode === 'enabled' && allowNet?.length ? allowNet.join(',') : undefined
  }
  return createDto
}

function mapState(state: string | BoxState | undefined): string {
  switch (state) {
    case BoxState.STARTED:
      return 'running'
    case BoxState.STOPPED:
    case BoxState.ARCHIVED:
      return 'stopped'
    case BoxState.CREATING:
    case BoxState.STARTING:
    case BoxState.RESTORING:
      return 'configured'
    case BoxState.STOPPING:
    case BoxState.DESTROYING:
    case BoxState.ARCHIVING:
      return 'stopping'
    case BoxState.ERROR:
    case BoxState.UNKNOWN:
    default:
      return 'unknown'
  }
}
