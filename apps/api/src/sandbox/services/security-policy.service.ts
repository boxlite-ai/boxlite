/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { SecurityOptionsDto, SecurityResourceLimitsDto, SecurityPreset } from '../dto/security-options.dto'

export interface PolicyContext {
  /** Organization ID — used for hosted-platform minimum-isolation rules. */
  organizationId?: string
  /** Whether this is a warm-pool (unassigned) sandbox. */
  isWarmPool?: boolean
}

export interface EffectiveSecurityResult {
  requested: Record<string, unknown> | undefined
  effective: Record<string, unknown>
  policyResult: {
    normalized: boolean
    rejectedFields: string[]
    warnings: string[]
  }
}

// Platform default mirrors SecurityOptions::standard() in Rust.
function platformDefault(): Record<string, unknown> {
  return {
    jailer_enabled: true,
    seccomp_enabled: false,
    network_enabled: true,
    close_fds: true,
    sanitize_env: true,
  }
}

const PRESET_DEFAULTS: Record<SecurityPreset, Record<string, unknown>> = {
  development: {
    jailer_enabled: false,
    seccomp_enabled: false,
    network_enabled: true,
    close_fds: false,
    sanitize_env: false,
  },
  standard: {
    jailer_enabled: true,
    seccomp_enabled: false,
    network_enabled: true,
    close_fds: true,
    sanitize_env: true,
  },
  maximum: {
    jailer_enabled: true,
    seccomp_enabled: true,
    network_enabled: true,
    close_fds: true,
    sanitize_env: true,
    resource_limits: {
      max_open_files: 1024,
      max_file_size: 1073741824,
      max_processes: 100,
    },
  },
}

// Fields that the runtime fully enforces (Stage 3 complete).
// Note: network_enabled is intentionally absent — it is enforced via Landlock which
// degrades gracefully on kernels without Landlock support, making it best-effort only.
// network_enabled is listed in PARTIAL_FIELDS instead.
const ENFORCED_FIELDS = new Set([
  'jailer_enabled', 'resource_limits',
  'sandbox_profile', 'close_fds', 'sanitize_env', 'env_allowlist',
])

// Fields accepted by the API but not yet fully enforced at runtime.
// Value is the truthy sentinel that indicates enforcement is expected:
//   boolean fields: true means the feature was requested (false is always safe/no-op)
//   non-boolean fields (uid, gid): any defined value triggers a warning
const PARTIAL_FIELDS: Array<{ field: string; warnWhen: (v: unknown) => boolean }> = [
  { field: 'uid', warnWhen: (v) => v !== undefined },
  { field: 'gid', warnWhen: (v) => v !== undefined },
  { field: 'new_pid_ns', warnWhen: (v) => v === true },
  { field: 'seccomp_enabled', warnWhen: (v) => v === true },
  // chroot isolation is accepted by the API but not yet wired through SandboxContext
  // or applied by BwrapSandbox at runtime.  Callers who set these fields would
  // receive an effective policy that appears to include chroot isolation when none
  // is actually applied — a false security signal.  Warn until the runtime is wired.
  { field: 'chroot_enabled', warnWhen: (v) => v === true },
  { field: 'chroot_base', warnWhen: (v) => v !== undefined && v !== null },
  // network_enabled=false is implemented via Linux Landlock LSM.  LandlockSandbox
  // degrades gracefully on kernels without Landlock support (< 5.13): it logs a
  // warning and continues without enforcement.  On such kernels, network_enabled=false
  // has no effect while the API would otherwise report it as enforced — a false
  // security guarantee.  Callers who require network isolation must independently
  // verify kernel support; we strip this from the effective policy for org sandboxes
  // to prevent false reliance on the guarantee.
  { field: 'network_enabled', warnWhen: (v) => v === false },
]

function dtoToSnakeCase(dto: SecurityOptionsDto): Record<string, unknown> {
  const obj: Record<string, unknown> = {}
  // Use != null (loose) so both null and undefined are treated as "not provided".
  // Boolean fields that arrive as null would bypass policy guards — treat as absent.
  if (dto.preset != null) obj['preset'] = dto.preset
  if (dto.jailerEnabled != null) obj['jailer_enabled'] = dto.jailerEnabled
  if (dto.seccompEnabled != null) obj['seccomp_enabled'] = dto.seccompEnabled
  if (dto.uid != null) obj['uid'] = dto.uid
  if (dto.gid != null) obj['gid'] = dto.gid
  if (dto.newPidNs != null) obj['new_pid_ns'] = dto.newPidNs
  if (dto.newNetNs != null) obj['new_net_ns'] = dto.newNetNs
  if (dto.chrootBase != null) obj['chroot_base'] = dto.chrootBase
  if (dto.chrootEnabled != null) obj['chroot_enabled'] = dto.chrootEnabled
  if (dto.closeFds != null) obj['close_fds'] = dto.closeFds
  if (dto.sanitizeEnv != null) obj['sanitize_env'] = dto.sanitizeEnv
  if (dto.envAllowlist != null) obj['env_allowlist'] = dto.envAllowlist
  if (dto.sandboxProfile != null) obj['sandbox_profile'] = dto.sandboxProfile
  if (dto.networkEnabled != null) obj['network_enabled'] = dto.networkEnabled
  if (dto.resourceLimits != null) {
    obj['resource_limits'] = resourceLimitsDtoToSnakeCase(dto.resourceLimits)
  }
  return obj
}

function resourceLimitsDtoToSnakeCase(dto: SecurityResourceLimitsDto): Record<string, unknown> {
  const obj: Record<string, unknown> = {}
  if (dto.maxOpenFiles !== undefined) obj['max_open_files'] = dto.maxOpenFiles
  if (dto.maxFileSize !== undefined) obj['max_file_size'] = dto.maxFileSize
  if (dto.maxProcesses !== undefined) obj['max_processes'] = dto.maxProcesses
  if (dto.maxMemory !== undefined) obj['max_memory'] = dto.maxMemory
  if (dto.maxCpuTime !== undefined) obj['max_cpu_time'] = dto.maxCpuTime
  return obj
}

@Injectable()
export class SecurityPolicyService {
  private readonly logger = new Logger(SecurityPolicyService.name)

  /**
   * Compute the effective SecurityOptions from the user-requested options.
   *
   * Resolution order:
   *   1. Platform default (standard preset)
   *   2. Override with preset defaults if preset is provided
   *   3. Override with explicit requested fields
   *   4. Apply policy guards (org-level minimum isolation, field rejection)
   */
  computeEffectiveSecurity(
    requested: SecurityOptionsDto | undefined,
    context: PolicyContext = {},
  ): EffectiveSecurityResult {
    const rejectedFields: string[] = []
    const warnings: string[] = []

    // Start from platform default
    const base: Record<string, unknown> = { ...platformDefault() }

    if (!requested) {
      // When sanitize_env is true and this is an org sandbox, ensure the effective policy
      // carries an explicit empty env_allowlist.  Without it the Rust deserializer expands
      // the absent field to default_env_allowlist() (RUST_LOG, PATH, HOME, USER, LANG, TERM).
      if (context.organizationId && base['sanitize_env'] === true) {
        base['env_allowlist'] = []
      }
      this.logger.log({
        event: 'sandbox.security.effective',
        preset: 'platform_default',
        organizationId: context.organizationId,
      })
      return {
        requested: undefined,
        effective: base,
        policyResult: { normalized: false, rejectedFields, warnings },
      }
    }

    const requestedSnake = dtoToSnakeCase(requested)

    this.logger.log({
      event: 'sandbox.security.requested',
      preset: requested.preset,
      fields: Object.keys(requestedSnake),
      organizationId: context.organizationId,
    })

    // Apply preset overrides first
    if (requested.preset) {
      const presetDefaults = PRESET_DEFAULTS[requested.preset]
      Object.assign(base, presetDefaults)
    }

    // Apply explicit field overrides (merge requested over base).
    // Treat null as absent: a null value for a boolean field must not override the
    // platform default and must not bypass policy guards that test for === false.
    for (const [key, value] of Object.entries(requestedSnake)) {
      if (key === 'preset') continue
      if (value != null) {
        base[key] = value
      }
    }

    // ─── Policy guards ─────────────────────────────────────────────────────

    // close_fds=false is rejected: FD cleanup is mandatory on the hosted platform.
    if (base['close_fds'] === false) {
      base['close_fds'] = true
      rejectedFields.push('close_fds=false (FD cleanup is mandatory; use true or omit)')
    }

    // new_net_ns=true is rejected: gvproxy requires the host network namespace.
    if (base['new_net_ns'] === true) {
      delete base['new_net_ns']
      rejectedFields.push('new_net_ns=true (incompatible with gvproxy VM networking)')
    }

    // Org/hosted-platform policy: production sandboxes must have the jailer enabled.
    // When organizationId is present this is a real tenant sandbox, not a local dev run.
    if (context.organizationId && base['jailer_enabled'] === false) {
      base['jailer_enabled'] = true
      rejectedFields.push('jailer_enabled=false (hosted platform requires jailer isolation; use SecurityOptions.development() only in local environments)')
    }

    // Org/hosted-platform policy: env sanitization is mandatory.
    // bwrap only calls --clearenv when sanitize_env is true; allowing a tenant to
    // disable it would expose the runner process environment (credentials, tokens) inside
    // the sandbox.  This guard applies regardless of how sanitize_env became false — direct
    // field override, the "development" preset, or any other path.
    if (context.organizationId && base['sanitize_env'] === false) {
      base['sanitize_env'] = true
      rejectedFields.push('sanitize_env=false (hosted platform requires environment sanitization; use SecurityOptions.development() only in local environments)')
    }

    // Org/hosted-platform policy: env_allowlist lets callers preserve arbitrary host variables
    // when sanitize_env is true.  On the hosted platform the runner process may hold credentials
    // or operational secrets; tenants must not be able to surface those into sandbox startup.
    // We must set an *explicit* empty list rather than deleting the field: if the field is absent
    // from the JSON the Rust deserializer fills it from default_env_allowlist()
    // (RUST_LOG, PATH, HOME, USER, LANG, TERM), defeating the sanitization guard.
    if (context.organizationId && base['sanitize_env'] === true) {
      if (base['env_allowlist'] !== undefined) {
        rejectedFields.push('env_allowlist (hosted: replaced with empty list to prevent Rust default expansion)')
      }
      base['env_allowlist'] = [] // explicit empty — absent field would expand to Rust defaults
    }

    // Org/hosted-platform policy: sandbox_profile accepts a macOS Seatbelt SBPL file path that
    // is forwarded to sandbox-exec on the runner.  A tenant-supplied path could point to a
    // permissive or no-op policy, silently bypassing the deny-default seatbelt profile.
    // Strip any tenant-supplied value so the runner always uses the built-in hardened profile.
    if (context.organizationId && base['sandbox_profile'] !== undefined) {
      delete base['sandbox_profile']
      rejectedFields.push('sandbox_profile (hosted platform does not allow tenant-supplied sandbox profiles; the runner uses its built-in hardened profile)')
    }

    // Warn about fields that are accepted but not yet fully enforced by the runtime.
    // Check the effective policy (base) rather than requestedSnake so that preset
    // expansions that imply a partial field also generate a warning. For example,
    // the "maximum" preset sets seccomp_enabled=true which is not yet fully enforced;
    // a caller using only { preset: 'maximum' } would otherwise see no warning.
    // Only warn when the field value actually requests enforcement (e.g. seccomp_enabled:false is harmless).
    //
    // For org (hosted) sandboxes, strip these fields from the effective policy so
    // callers are not given a false security signal — the effective policy must only
    // contain fields that are actually applied by the runtime.
    for (const { field, warnWhen } of PARTIAL_FIELDS) {
      if (warnWhen(base[field])) {
        warnings.push(`${field}: accepted but runtime enforcement is not yet complete`)
        if (context.organizationId) {
          delete base[field]
        }
      }
    }

    const normalized = rejectedFields.length > 0

    if (rejectedFields.length > 0) {
      this.logger.warn({
        event: 'sandbox.security.policy_rejected',
        rejectedFields,
        organizationId: context.organizationId,
      })
    }

    if (warnings.length > 0) {
      this.logger.warn({
        event: 'sandbox.security.runtime_unsupported',
        warnings,
        organizationId: context.organizationId,
      })
    }

    this.logger.log({
      event: 'sandbox.security.effective',
      preset: requested.preset ?? 'custom',
      effectiveJailerEnabled: base['jailer_enabled'],
      organizationId: context.organizationId,
    })

    return {
      requested: requestedSnake,
      effective: base,
      policyResult: { normalized, rejectedFields, warnings },
    }
  }
}
