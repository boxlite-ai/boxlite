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

export class CreateBoxDto {
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

  // Accepted and ignored, deliberately. Cloud boxes always outlive the request
  // that created them: the runner hardcodes WithDetach(true) and must, since a
  // box tied to the runner process would vanish on every runner restart.
  //
  // Rejecting `false` looks right and is not: CreateBoxRequest::from_options
  // sends `detach` unconditionally (src/boxlite/src/rest/types.rs) and
  // BoxOptions::detach defaults to false, so the Rust core — and every SDK and
  // the CLI riding it — puts `"detach": false` on every create that did not
  // pass `-d`. There is no way to tell that apart from a caller who asked for
  // it, so refusing it would 400 the default first-party path.
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

  // The remaining CreateBoxRequest fields this server does not implement.
  // Without these, whitelisting reports them as a bare "property X should not
  // exist", which tells a caller nothing about why or what to do instead.
  //
  // Host port publication. Absent from the spec by design and refused by the
  // Rust preflight before it ever reaches the wire, so no in-repo client sends
  // it — but a raw HTTP caller can, and whitelisting alone would answer with a
  // bare "property ports should not exist". Mirror the guidance
  // BoxOptions::sanitize_remote gives instead.
  @ValidateIf((_, value) => value !== undefined)
  @IsIn([undefined], {
    message: 'host port publication is local-only; use the box network tunnel endpoint to reach a guest service',
  })
  ports?: never

  // A PTY for the box's main command. The runner offers one for executions
  // only (StartExecution's tty flag), never for the container's init, and the
  // Go SDK has no WithTTY to carry it. `false` is a no-op so the flag can be
  // sent unconditionally. Lift this once the runner can start an init on a
  // terminal.
  @ValidateIf((_, value) => value !== undefined)
  @IsIn([false], {
    message: 'tty is not supported for cloud boxes; request a tty on the execution instead',
  })
  tty?: false

  // `secrets` matters most: the field carries real credential values, and this
  // server dropped them silently for its whole life — the caller got a 201 and
  // a box whose outbound requests still held the placeholder.
  @ValidateIf((_, value) => value !== undefined)
  @IsIn([undefined], {
    message:
      'secrets are not supported for cloud boxes; the MITM placeholder substitution runs host-side and has no cloud equivalent yet',
  })
  secrets?: never

  // A path on the server's own filesystem. Meaningful for a single-tenant
  // `boxlite serve`, never for a shared control plane.
  @ValidateIf((_, value) => value !== undefined)
  @IsIn([undefined], {
    message: 'rootfs_path is local-only; use image instead',
  })
  rootfs_path?: never

  // advanced.capabilities is implemented by `boxlite serve` and the reference
  // server; the runner has no path for it yet. Lift this once the runner
  // forwards a capability policy.
  @ValidateIf((_, value) => value !== undefined)
  @IsIn([undefined], {
    message: 'advanced options are not supported for cloud boxes',
  })
  advanced?: never
}
