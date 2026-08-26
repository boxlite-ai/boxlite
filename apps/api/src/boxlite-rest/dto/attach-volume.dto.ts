/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { IsIn, IsNotEmpty, IsString, ValidateIf } from 'class-validator'

export class AttachVolumeDto {
  // Id or name — BoxService.attachVolume resolves either against this
  // organization's volumes (VolumeService.findOneByIdOrName).
  @IsString()
  @IsNotEmpty()
  volume: string

  @IsString()
  @IsNotEmpty()
  guest_path: string

  // Not yet enforced at the mount layer (see box.dto.ts BoxVolume.readOnly),
  // so - same as VolumeSpecDto.read_only on create - only `false` validates;
  // an explicit `true` fails loudly instead of silently mounting read-write.
  @ValidateIf((_, value) => value !== undefined)
  @IsIn([false])
  read_only?: false
}
