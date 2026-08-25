/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, Logger } from '@nestjs/common'
import { Transform, Type, plainToInstance } from 'class-transformer'
import {
  ArrayMaxSize,
  IsNotEmpty,
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
import { isValidLinuxCapabilityName } from '../../box/utils/advanced-options.util'

const logger = new Logger('CreateBoxDto')

@ValidatorConstraint({ name: 'isNetworkAllowEntry', async: false })
class IsNetworkAllowEntryConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && isValidNetworkAllowEntry(value)
  }

  defaultMessage(): string {
    return 'each allow_net entry must be an IPv4 address, IPv4 CIDR, hostname, or wildcard hostname'
  }
}

// Attached to `guest_path` (always validated) rather than `source`, since
// `@IsOptional()` on `source` would skip a validator stacked on that same
// property whenever `source` is absent - exactly the case this needs to see.
@ValidatorConstraint({ name: 'hasVolumeSource', async: false })
class HasVolumeSourceConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const volume = args.object as VolumeSpecDto
    return typeof volume.source === 'string' || typeof volume.host_path === 'string'
  }

  defaultMessage(): string {
    return 'volume requires source (or the deprecated host_path)'
  }
}

@ValidatorConstraint({ name: 'isLinuxCapabilityName', async: false })
class IsLinuxCapabilityNameConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return isValidLinuxCapabilityName(value)
  }

  defaultMessage(): string {
    return 'each capability must be a well-formed Linux capability name'
  }
}

export class OutboundNetworkSpecDto {
  @IsIn(['enabled', 'disabled'])
  mode: 'enabled' | 'disabled'

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_NETWORK_ALLOW_LIST_ENTRIES)
  @IsString({ each: true })
  @Validate(IsNetworkAllowEntryConstraint, { each: true })
  allow_net?: string[]
}

// Rejects any non-empty inbound allowlist: no layer enforces it yet (the
// proxy gates purely on mode), so accepting one would hand the caller a
// box that is fully open while they believe it is restricted. Lift this
// once inbound allowlist enforcement lands.
@ValidatorConstraint({ name: 'isUnsupportedInboundAllowNet', async: false })
class IsUnsupportedInboundAllowNetConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return value === undefined || (Array.isArray(value) && value.length === 0)
  }

  defaultMessage(): string {
    return 'inbound.allow_net is not supported yet; remove it (inbound access is controlled by mode only)'
  }
}

// Aligned field-for-field with OutboundNetworkSpecDto: mode="enabled" means
// services the box exposes are publicly reachable; mode="disabled" means
// private. allow_net exists for wire-shape symmetry but is rejected when
// non-empty until enforcement exists.
export class InboundNetworkSpecDto {
  @IsIn(['enabled', 'disabled'])
  mode: 'enabled' | 'disabled'

  @IsOptional()
  @Validate(IsUnsupportedInboundAllowNetConstraint)
  allow_net?: string[]
}

export class NetworkSpecDto {
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => OutboundNetworkSpecDto)
  outbound?: OutboundNetworkSpecDto

  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => InboundNetworkSpecDto)
  inbound?: InboundNetworkSpecDto
}

// Deprecated legacy wire shape, predating the outbound/inbound split:
// `{ mode, allow_net }` at the top level of `network`, instead of nested
// under `outbound`. Still accepted so already-deployed callers keep
// working; normalized into the nested shape here and logged so callers can
// be tracked down and migrated. Mixing legacy and nested fields in the same
// request is rejected outright — there's no sane precedence to guess
// between them.
function normalizeNetworkShape(value: unknown): NetworkSpecDto | unknown {
  // `network: []` used to slip through: before `@IsObject()` was added here,
  // `@ValidateNested()` treated an array as a list to validate element-wise,
  // so an empty one passed and behaved exactly like omitting `network`. Keep
  // that verdict by mapping it to absent. A non-empty array still falls
  // through to `@IsObject()` and is rejected, as it was before.
  if (Array.isArray(value)) {
    return value.length === 0 ? undefined : value
  }
  if (value === undefined || value === null || typeof value !== 'object') {
    return value
  }
  const network = value as Record<string, unknown>
  const hasLegacyField = 'mode' in network || 'allow_net' in network
  const hasNestedField = 'outbound' in network || 'inbound' in network

  if (hasLegacyField && hasNestedField) {
    throw new BadRequestException('network must not mix legacy top-level fields with nested outbound/inbound fields')
  }
  if (!hasLegacyField) {
    return plainToInstance(NetworkSpecDto, network)
  }

  logger.warn(
    'Deprecated: network.{mode,allow_net} — use network.{outbound,inbound}. Support for the flat shape will be removed in a future release.',
  )

  const { mode, allow_net, ...rest } = network
  // allow_net alone (no explicit mode) implies enabled, matching outbound's
  // existing default — an allowlist with nothing to enable would be inert.
  const outbound = mode !== undefined || allow_net !== undefined ? { mode: mode ?? 'enabled', allow_net } : undefined
  return plainToInstance(NetworkSpecDto, { ...rest, outbound })
}

export class VolumeSpecDto {
  // IsNotEmpty (not just IsOptional + IsString) so an explicit `source: ''`
  // is a validation error on its own rather than being treated as "absent"
  // and silently falling through to host_path in the mapper.
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  source?: string

  /**
   * @deprecated Use `source` with the `volume://<volume_id>` scheme instead.
   * Accepted for backward compatibility with existing /v1 clients built
   * against the pre-managed-volumes `VolumeSpec` schema; will be removed.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  host_path?: string

  @IsString()
  @Validate(HasVolumeSourceConstraint)
  guest_path: string

  @ValidateIf((_, value) => value !== undefined)
  @IsIn([false])
  read_only?: false
}

export class CreateBoxCapabilitiesDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Validate(IsLinuxCapabilityNameConstraint, { each: true })
  add?: string[]

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Validate(IsLinuxCapabilityNameConstraint, { each: true })
  drop?: string[]
}

export class CreateBoxAdvancedOptionsDto {
  @IsOptional()
  @IsBoolean()
  privileged?: boolean

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateBoxCapabilitiesDto)
  capabilities?: CreateBoxCapabilitiesDto
}

export class CreateBoxDto {
  @IsOptional()
  @ValidateNested()
  @Type(() => CreateBoxAdvancedOptionsDto)
  advanced?: CreateBoxAdvancedOptionsDto

  @IsOptional()
  @IsString()
  name?: string

  @IsOptional()
  @IsString()
  image?: string

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

  @IsOptional()
  @IsArray()
  entrypoint?: string[]

  @IsOptional()
  @IsArray()
  cmd?: string[]

  @IsOptional()
  @IsString()
  user?: string

  @IsOptional()
  @IsBoolean()
  detach?: boolean

  @IsOptional()
  @IsNumber()
  @Min(0)
  auto_stop?: number

  @IsOptional()
  @IsNumber()
  @Min(0)
  auto_delete?: number

  @IsOptional()
  @IsBoolean()
  auto_resume?: boolean

  @IsOptional()
  @IsObject()
  @Transform(({ value }) => normalizeNetworkShape(value))
  @ValidateNested()
  network?: NetworkSpecDto

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => VolumeSpecDto)
  volumes?: VolumeSpecDto[]
}
