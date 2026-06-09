/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
} from 'class-validator'
import { Transform, Type, plainToInstance } from 'class-transformer'
import { ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'

export const SECURITY_PRESETS = ['development', 'standard', 'maximum'] as const
export type SecurityPreset = (typeof SECURITY_PRESETS)[number]

// Known field names for SecurityResourceLimitsDto — both camelCase and snake_case
// variants are listed because the Transform decorators read from the raw object.
const KNOWN_RESOURCE_LIMIT_KEYS = new Set([
  'maxOpenFiles', 'max_open_files',
  'maxFileSize', 'max_file_size',
  'maxProcesses', 'max_processes',
  'maxMemory', 'max_memory',
  'maxCpuTime', 'max_cpu_time',
])

// Known field names for SecurityOptionsDto — both naming conventions accepted.
const KNOWN_SECURITY_OPTION_KEYS = new Set([
  'preset',
  'jailerEnabled', 'jailer_enabled',
  'seccompEnabled', 'seccomp_enabled',
  'uid', 'gid',
  'newPidNs', 'new_pid_ns',
  'newNetNs', 'new_net_ns',
  'chrootBase', 'chroot_base',
  'chrootEnabled', 'chroot_enabled',
  'closeFds', 'close_fds',
  'sanitizeEnv', 'sanitize_env',
  'envAllowlist', 'env_allowlist',
  'sandboxProfile', 'sandbox_profile',
  'networkEnabled', 'network_enabled',
  'resourceLimits', 'resource_limits',
])

/**
 * Rejects any key in the raw input object that is not in the provided known-key set.
 *
 * Strategy: the sentinel property is populated by a @Transform that captures the
 * raw source object (obj) and stores the array of unknown key names found on it.
 * The validator then checks whether that array is empty.
 *
 * Without this guard a typo like `seccomp_enabledd: true` passes the DTO boundary
 * with no error and is silently discarded — the caller gets a false security signal.
 */
@ValidatorConstraint({ name: 'noUnknownKeys', async: false })
class NoUnknownKeysConstraint implements ValidatorConstraintInterface {
  // value is the unknown-key array stored by the @Transform on the sentinel property.
  validate(value: unknown, _args: ValidationArguments): boolean {
    // If transform never ran (e.g., programmatic construction), skip the guard.
    if (!Array.isArray(value)) return true
    return value.length === 0
  }

  defaultMessage(args: ValidationArguments): string {
    const unknownKeys = args.value as string[]
    return `Unknown field(s): ${unknownKeys.join(', ')}. Check for typos — unknown security fields are rejected to prevent silent misconfiguration.`
  }
}

@ApiSchema({ name: 'SecurityResourceLimits' })
export class SecurityResourceLimitsDto {
  /**
   * Sentinel property: the @Transform captures the raw input object and extracts
   * any keys that are not in KNOWN_RESOURCE_LIMIT_KEYS. The @Validate then rejects
   * the DTO if the array is non-empty. The property is excluded from Swagger output
   * and is not forwarded to the policy service.
   */
  @Transform(({ obj }) => Object.keys(obj as Record<string, unknown>).filter((k) => !KNOWN_RESOURCE_LIMIT_KEYS.has(k)))
  @Validate(NoUnknownKeysConstraint)
  _noUnknownKeys?: string[]

  @ApiPropertyOptional({ description: 'Maximum open file descriptors (RLIMIT_NOFILE)', example: 1024 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  @Transform(({ obj }) => obj.maxOpenFiles ?? obj.max_open_files)
  maxOpenFiles?: number

  @ApiPropertyOptional({ description: 'Maximum file size in bytes (RLIMIT_FSIZE)', example: 1073741824 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  @Transform(({ obj }) => obj.maxFileSize ?? obj.max_file_size)
  maxFileSize?: number

  @ApiPropertyOptional({ description: 'Maximum number of processes (RLIMIT_NPROC)', example: 256 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  @Transform(({ obj }) => obj.maxProcesses ?? obj.max_processes)
  maxProcesses?: number

  @ApiPropertyOptional({ description: 'Maximum virtual memory in bytes (RLIMIT_AS)', example: 2147483648 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  @Transform(({ obj }) => obj.maxMemory ?? obj.max_memory)
  maxMemory?: number

  @ApiPropertyOptional({ description: 'Maximum CPU time in seconds (RLIMIT_CPU)', example: 3600 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  @Transform(({ obj }) => obj.maxCpuTime ?? obj.max_cpu_time)
  maxCpuTime?: number
}

@ApiSchema({ name: 'SecurityOptions' })
export class SecurityOptionsDto {
  /**
   * Sentinel property: the @Transform captures the raw input object and extracts
   * any keys that are not in KNOWN_SECURITY_OPTION_KEYS. The @Validate rejects
   * the DTO if the array is non-empty. Not forwarded to the policy service.
   */
  @Transform(({ obj }) => Object.keys(obj as Record<string, unknown>).filter((k) => !KNOWN_SECURITY_OPTION_KEYS.has(k)))
  @Validate(NoUnknownKeysConstraint)
  _noUnknownKeys?: string[]

  @ApiPropertyOptional({
    description: 'Convenience security preset. Explicit fields override preset values.',
    enum: SECURITY_PRESETS,
    example: 'standard',
  })
  @IsOptional()
  @IsIn(SECURITY_PRESETS)
  preset?: SecurityPreset

  @ApiPropertyOptional({ description: 'Enable platform sandbox wrapping (jailer)', example: true })
  @IsOptional()
  @IsBoolean()
  @Transform(({ obj }) => { const v = obj.jailerEnabled ?? obj.jailer_enabled; return v === null ? undefined : v })
  jailerEnabled?: boolean

  @ApiPropertyOptional({ description: 'Enable Linux seccomp syscall filtering (requires jailerEnabled)', example: true })
  @IsOptional()
  @IsBoolean()
  @Transform(({ obj }) => { const v = obj.seccompEnabled ?? obj.seccomp_enabled; return v === null ? undefined : v })
  seccompEnabled?: boolean

  @ApiPropertyOptional({ description: 'UID to drop shim process to (Linux only, null = auto)', example: null })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(65535)
  uid?: number | null

  @ApiPropertyOptional({ description: 'GID to drop shim process to (Linux only, null = auto)', example: null })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(65535)
  gid?: number | null

  @ApiPropertyOptional({ description: 'Create new PID namespace (Linux only)', example: false })
  @IsOptional()
  @IsBoolean()
  @Transform(({ obj }) => { const v = obj.newPidNs ?? obj.new_pid_ns; return v === null ? undefined : v })
  newPidNs?: boolean

  @ApiPropertyOptional({ description: 'Create new network namespace (Linux only)', example: false })
  @IsOptional()
  @IsBoolean()
  @Transform(({ obj }) => { const v = obj.newNetNs ?? obj.new_net_ns; return v === null ? undefined : v })
  newNetNs?: boolean

  @ApiPropertyOptional({ description: 'Base directory for chroot jails (Linux only)', example: null })
  @IsOptional()
  @IsString()
  @Transform(({ obj }) => obj.chrootBase ?? obj.chroot_base)
  chrootBase?: string | null

  @ApiPropertyOptional({ description: 'Enable chroot filesystem isolation (Linux only)', example: true })
  @IsOptional()
  @IsBoolean()
  @Transform(({ obj }) => { const v = obj.chrootEnabled ?? obj.chroot_enabled; return v === null ? undefined : v })
  chrootEnabled?: boolean

  @ApiPropertyOptional({ description: 'Close inherited file descriptors before VM start', example: true })
  @IsOptional()
  @IsBoolean()
  @Transform(({ obj }) => { const v = obj.closeFds ?? obj.close_fds; return v === null ? undefined : v })
  closeFds?: boolean

  @ApiPropertyOptional({ description: 'Sanitize environment variables before shim exec', example: true })
  @IsOptional()
  @IsBoolean()
  @Transform(({ obj }) => { const v = obj.sanitizeEnv ?? obj.sanitize_env; return v === null ? undefined : v })
  sanitizeEnv?: boolean

  @ApiPropertyOptional({
    description: 'Environment variables to preserve when sanitizeEnv is true',
    type: [String],
    example: ['PATH', 'HOME'],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ obj }) => obj.envAllowlist ?? obj.env_allowlist)
  envAllowlist?: string[]

  @ApiPropertyOptional({ description: 'Process resource limits', type: SecurityResourceLimitsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => SecurityResourceLimitsDto)
  @Transform(({ obj }) => {
    // Accept both camelCase (resourceLimits) and snake_case (resource_limits) input.
    // class-transformer does NOT re-apply @Type conversion after @Transform returns a
    // plain object, so we must explicitly instantiate SecurityResourceLimitsDto here.
    // Without plainToInstance the nested @Transform decorators on maxOpenFiles etc.
    // never run, and snake_case keys like max_open_files are silently dropped.
    const raw = obj.resourceLimits ?? obj.resource_limits
    if (raw == null) return undefined
    return plainToInstance(SecurityResourceLimitsDto, raw)
  })
  resourceLimits?: SecurityResourceLimitsDto

  @ApiPropertyOptional({ description: 'macOS sandbox profile identifier (allowlisted values only)', example: null })
  @IsOptional()
  @IsString()
  @Transform(({ obj }) => obj.sandboxProfile ?? obj.sandbox_profile)
  sandboxProfile?: string | null

  @ApiPropertyOptional({ description: 'Enable network access in sandbox', example: true })
  @IsOptional()
  @IsBoolean()
  @Transform(({ obj }) => { const v = obj.networkEnabled ?? obj.network_enabled; return v === null ? undefined : v })
  networkEnabled?: boolean
}
