/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { SandboxDto } from '../../sandbox/dto/sandbox.dto'
import { SandboxState } from '../../sandbox/enums/sandbox-state.enum'
import { BoxResponseDto } from '../dto/box-response.dto'
import { CreateBoxDto } from '../dto/create-box.dto'
import { CreateSandboxDto } from '../../sandbox/dto/create-sandbox.dto'

export function sandboxToBoxResponse(sandbox: SandboxDto): BoxResponseDto {
  return {
    box_id: sandbox.id,
    name: sandbox.name,
    status: mapState(sandbox.state),
    created_at: sandbox.createdAt || new Date().toISOString(),
    updated_at: sandbox.updatedAt || new Date().toISOString(),
    image: sandbox.snapshot || '',
    cpus: sandbox.cpu || 1,
    memory_mib: (sandbox.memory || 1) * 1024,
    labels: sandbox.labels || {},
  }
}

export function createBoxToCreateSandbox(dto: CreateBoxDto, target?: string): CreateSandboxDto {
  const createDto = new CreateSandboxDto()
  createDto.name = dto.name
  createDto.snapshot = dto.image
  createDto.user = dto.user
  createDto.env = dto.env
  createDto.cpu = dto.cpus
  createDto.memory = dto.memory_mib ? Math.ceil(dto.memory_mib / 1024) : undefined
  createDto.disk = dto.disk_size_gb
  createDto.target = target
  return createDto
}

function mapState(state: string | SandboxState | undefined): string {
  switch (state) {
    case SandboxState.STARTED:
      return 'running'
    case SandboxState.STOPPED:
    case SandboxState.ARCHIVED:
      return 'stopped'
    case SandboxState.CREATING:
    case SandboxState.STARTING:
    case SandboxState.RESTORING:
    case SandboxState.PULLING_SNAPSHOT:
    case SandboxState.BUILDING_SNAPSHOT:
    case SandboxState.PENDING_BUILD:
      return 'configured'
    case SandboxState.STOPPING:
    case SandboxState.DESTROYING:
    case SandboxState.ARCHIVING:
      return 'stopping'
    case SandboxState.ERROR:
    case SandboxState.BUILD_FAILED:
    case SandboxState.UNKNOWN:
    default:
      return 'unknown'
  }
}
