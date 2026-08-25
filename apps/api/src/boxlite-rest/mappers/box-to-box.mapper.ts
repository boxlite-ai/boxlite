/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'
import { BoxDto } from '../../box/dto/box.dto'
import { BoxState } from '../../box/enums/box-state.enum'
import {
  AUTO_DELETE_DISABLED,
  DEFAULT_AUTO_STOP_SECONDS,
  DEFAULT_AUTO_RESUME,
} from '../../box/constants/box-lifecycle.constants'
import { BoxResponseDto } from '../dto/box-response.dto'
import { CreateBoxDto as RestCreateBoxDto } from '../dto/create-box.dto'
import { CreateBoxDto } from '../../box/dto/create-box.dto'
import { normalizeBoxAdvancedOptions } from '../../box/utils/advanced-options.util'

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
    auto_stop: box.autoStop ?? DEFAULT_AUTO_STOP_SECONDS,
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
  createDto.autoStop = dto.auto_stop
  createDto.autoDelete = dto.auto_delete
  createDto.autoResume = dto.auto_resume
  createDto.volumes = dto.volumes?.map((volume) => ({
    volumeId: resolveVolumeId(volume),
    mountPath: volume.guest_path,
  }))
  const advanced = normalizeBoxAdvancedOptions(dto.advanced)
  createDto.privileged = advanced.privileged
  createDto.capabilities = advanced.capabilities
  if (dto.network) {
    const allowNet = dto.network.outbound?.allow_net?.map((entry) => entry.trim()).filter(Boolean)
    createDto.networkBlockAll = dto.network.outbound?.mode === 'disabled'
    createDto.networkAllowList =
      dto.network.outbound?.mode === 'enabled' && allowNet?.length ? allowNet.join(',') : undefined
    // The runner DTO only has a public/private boolean; a non-empty
    // inbound.allow_net never reaches here — the DTO rejects it at the
    // request boundary until enforcement exists.
    createDto.public = dto.network.inbound?.mode ? dto.network.inbound.mode === 'enabled' : undefined
  }
  return createDto
}

function resolveVolumeId(volume: NonNullable<RestCreateBoxDto['volumes']>[number]): string {
  // `host_path` is the deprecated pre-managed-volumes field name; DTO
  // validation (HasVolumeSourceConstraint) already guarantees one of the two
  // is present.
  const source = volume.source ?? volume.host_path
  if (source?.startsWith('volume://')) {
    const volumeId = source.slice('volume://'.length)
    if (volumeId) {
      return volumeId
    }
  }
  throw new BadRequestException('volume source must use the volume:// scheme')
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
