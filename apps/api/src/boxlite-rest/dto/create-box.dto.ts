/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  IsOptional,
  IsString,
  IsNumber,
  IsBoolean,
  IsObject,
  IsArray,
  Min,
  IsIn,
  Validate,
  ValidateIf,
  ValidateNested,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator'
import { isValidNetworkAllowEntry, MAX_NETWORK_ALLOW_LIST_ENTRIES } from '../../box/utils/network-validation.util'
import { CreateBoxAdvancedOptionsDto } from '../../box/dto/create-box.dto'

@ValidatorConstraint({ name: 'isNetworkAllowEntry', async: false })
class IsNetworkAllowEntryConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isValidNetworkAllowEntry(value)
  }

  defaultMessage(): string {
    return 'each allow_net entry must be an IPv4 address, IPv4 CIDR, hostname, or wildcard hostname'
  }
}

@ValidatorConstraint({ name: 'isUnsupportedCloudCreateOption', async: false })
class IsUnsupportedCloudCreateOptionConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return value === undefined
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} is not supported by the cloud REST API`
  }
}

export class NetworkSpecDto {
  @IsIn(['enabled', 'disabled'])
  mode: 'enabled' | 'disabled'

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_NETWORK_ALLOW_LIST_ENTRIES)
  @IsString({ each: true })
  @Validate(IsNetworkAllowEntryConstraint, { each: true })
  allow_net?: string[]
}

export class CreateBoxDto {
  @IsOptional()
  @IsString()
  name?: string

  @IsOptional()
  @IsString()
  image?: string

  // The local runtime can consume an OCI layout from its own filesystem, but
  // a cloud API path cannot safely interpret a client-local path. Declare the
  // wire field so strict validation reports the real incompatibility instead
  // of treating it as an unknown option or silently dropping it.
  @Validate(IsUnsupportedCloudCreateOptionConstraint)
  rootfs_path?: string

  // A box with 0 vCPUs can never boot (libkrun set_vm_config(0, ...) → EINVAL),
  // so reject undersized resources at the request boundary instead of accepting
  // a box that fails to start.
  @IsOptional()
  @IsNumber()
  @Min(1)
  cpus?: number

  @IsOptional()
  @IsNumber()
  @Min(256)
  memory_mib?: number

  @IsOptional()
  @IsNumber()
  @Min(1)
  disk_size_gb?: number

  @IsOptional()
  @IsString()
  working_dir?: string

  @IsOptional()
  @IsObject()
  env?: Record<string, string>

  // Secret substitution has no persisted control-plane/runner contract yet.
  // Reject it at both validation and mapper boundaries until that contract
  // exists; accepting and discarding a secret would be unsafe.
  @Validate(IsUnsupportedCloudCreateOptionConstraint)
  secrets?: unknown[]

  @IsOptional()
  @IsArray()
  entrypoint?: string[]

  @IsOptional()
  @IsArray()
  cmd?: string[]

  @IsOptional()
  @IsString()
  user?: string

  @ValidateIf((_object, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => CreateBoxAdvancedOptionsDto)
  advanced?: CreateBoxAdvancedOptionsDto

  @IsOptional()
  @IsBoolean()
  detach?: boolean

  // The runner create DTO currently has no container-init TTY field. Keep the
  // strict endpoint fail-closed rather than degrading an interactive request
  // to pipes.
  @Validate(IsUnsupportedCloudCreateOptionConstraint)
  tty?: boolean

  @IsOptional()
  @IsNumber()
  @Min(0)
  auto_pause?: number

  @IsOptional()
  @IsNumber()
  @Min(0)
  auto_delete?: number

  @IsOptional()
  @IsBoolean()
  auto_resume?: boolean

  @IsOptional()
  @ValidateNested()
  @Type(() => NetworkSpecDto)
  network?: NetworkSpecDto
}
