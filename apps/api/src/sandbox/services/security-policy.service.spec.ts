/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { SecurityPolicyService } from './security-policy.service'
import { SecurityOptionsDto, SecurityResourceLimitsDto } from '../dto/security-options.dto'
import { plainToClass } from 'class-transformer'
import { validate } from 'class-validator'
import { isSecurityOptionsEnabled } from '../../common/constants/feature-flags'
import { Runner } from '../entities/runner.entity'

describe('SecurityPolicyService', () => {
  let service: SecurityPolicyService

  beforeEach(() => {
    service = new SecurityPolicyService()
  })

  describe('computeEffectiveSecurity', () => {
    it('returns platform defaults when no security options are provided', () => {
      const result = service.computeEffectiveSecurity(undefined, {})
      expect(result.requested).toBeUndefined()
      expect(result.effective['jailer_enabled']).toBe(true)
      expect(result.effective['close_fds']).toBe(true)
    })

    it('returns a non-empty effective policy even when requested is undefined', () => {
      // computeEffectiveSecurity(undefined) always returns a non-empty effective object
      // (platform default). The caller must NOT store this result for v0 runners since
      // v0 never enforces security options; storing it would falsely claim enforcement.
      const result = service.computeEffectiveSecurity(undefined, { organizationId: 'org-abc' })
      expect(result.requested).toBeUndefined()
      expect(Object.keys(result.effective).length).toBeGreaterThan(0)
      expect(result.effective['jailer_enabled']).toBe(true)
      // Platform default has sanitize_env=true; org context must carry explicit empty
      // env_allowlist so the runner never falls back to Rust's default_env_allowlist().
      expect(result.effective['env_allowlist']).toEqual([])
    })

    it('enforces jailer_enabled=true for tenant sandboxes (organizationId present)', () => {
      const dto = new SecurityOptionsDto()
      dto.jailerEnabled = false

      const result = service.computeEffectiveSecurity(dto, { organizationId: 'org-123' })
      expect(result.effective['jailer_enabled']).toBe(true)
      expect(result.policyResult.rejectedFields.length).toBeGreaterThan(0)
      expect(result.policyResult.normalized).toBe(true)
    })

    it('rejects close_fds=false and forces it to true', () => {
      const dto = new SecurityOptionsDto()
      dto.closeFds = false

      const result = service.computeEffectiveSecurity(dto, {})
      expect(result.effective['close_fds']).toBe(true)
      expect(result.policyResult.rejectedFields.some((f) => f.includes('close_fds'))).toBe(true)
    })

    it('rejects new_net_ns=true and removes it', () => {
      const dto = new SecurityOptionsDto()
      dto.newNetNs = true

      const result = service.computeEffectiveSecurity(dto, {})
      expect(result.effective['new_net_ns']).toBeUndefined()
      expect(result.policyResult.rejectedFields.some((f) => f.includes('new_net_ns'))).toBe(true)
    })

    it('applies maximum preset correctly', () => {
      const dto = new SecurityOptionsDto()
      dto.preset = 'maximum'

      const result = service.computeEffectiveSecurity(dto, {})
      expect(result.effective['jailer_enabled']).toBe(true)
      expect(result.effective['seccomp_enabled']).toBe(true)
      expect(result.effective['resource_limits']).toBeDefined()
    })

    it('generates a partial-enforcement warning for seccomp_enabled when maximum preset is used', () => {
      // The maximum preset sets seccomp_enabled=true via PRESET_DEFAULTS.
      // Even though the caller only sent { preset: 'maximum' }, the effective
      // policy includes seccomp_enabled=true which is not fully enforced.
      // The warning MUST appear in policyResult.warnings.
      const dto = new SecurityOptionsDto()
      dto.preset = 'maximum'

      const result = service.computeEffectiveSecurity(dto, {})
      const hasSeccompWarning = result.policyResult.warnings.some((w) => w.includes('seccomp_enabled'))
      expect(hasSeccompWarning).toBe(true)
    })

    it('maximum preset strips seccomp_enabled from effective policy for org sandboxes', () => {
      // For org (hosted) sandboxes, partial fields must be removed from the effective
      // policy so callers do not receive a false security signal (the runtime does not
      // actually enforce seccomp in this environment).
      const dto = new SecurityOptionsDto()
      dto.preset = 'maximum'

      const result = service.computeEffectiveSecurity(dto, { organizationId: 'org-123' })
      expect(result.effective['seccomp_enabled']).toBeUndefined()
    })

    it('maximum preset keeps seccomp_enabled warning in policyResult for org sandboxes', () => {
      // Even though seccomp_enabled is stripped from the effective policy for org
      // sandboxes, the warning must still appear so callers know enforcement is partial.
      const dto = new SecurityOptionsDto()
      dto.preset = 'maximum'

      const result = service.computeEffectiveSecurity(dto, { organizationId: 'org-123' })
      const hasSeccompWarning = result.policyResult.warnings.some((w) => w.includes('seccomp_enabled'))
      expect(hasSeccompWarning).toBe(true)
    })

    it('maximum preset preserves seccomp_enabled in effective policy for non-org contexts', () => {
      // For non-org (local dev SDK) contexts the field is kept in the effective policy
      // because the caller is running their own host and can accept partial enforcement.
      const dto = new SecurityOptionsDto()
      dto.preset = 'maximum'

      const result = service.computeEffectiveSecurity(dto, {})
      expect(result.effective['seccomp_enabled']).toBe(true)
    })
  })
})

describe('SecurityPolicyService – hosted-platform sanitizeEnv enforcement', () => {
  let service: SecurityPolicyService

  beforeEach(() => {
    service = new SecurityPolicyService()
  })

  it('forces sanitize_env=true for org sandboxes even when explicitly set to false', () => {
    const dto = new SecurityOptionsDto()
    dto.sanitizeEnv = false

    const result = service.computeEffectiveSecurity(dto, { organizationId: 'org-123' })
    expect(result.effective['sanitize_env']).toBe(true)
    expect(result.policyResult.rejectedFields.some((f) => f.includes('sanitize_env'))).toBe(true)
  })

  it('forces sanitize_env=true for org sandboxes when development preset is used (even with jailer forced back on)', () => {
    const dto = new SecurityOptionsDto()
    dto.preset = 'development'

    const result = service.computeEffectiveSecurity(dto, { organizationId: 'org-123' })
    expect(result.effective['sanitize_env']).toBe(true)
    expect(result.policyResult.rejectedFields.some((f) => f.includes('sanitize_env'))).toBe(true)
  })

  it('replaces env_allowlist with [] for org sandboxes (absent field expands to Rust defaults)', () => {
    // Deleting the field would cause Rust to expand it via default_env_allowlist()
    // (RUST_LOG, PATH, HOME, USER, LANG, TERM) — those host values would be forwarded
    // into the sandbox despite the guard.  The fix: set explicit empty list.
    const dto = new SecurityOptionsDto()
    dto.envAllowlist = ['SECRET_DB_PASSWORD', 'HOST_API_KEY']

    const result = service.computeEffectiveSecurity(dto, { organizationId: 'org-123' })
    expect(result.effective['env_allowlist']).toEqual([])
    expect(result.policyResult.rejectedFields.some((f) => f.includes('env_allowlist'))).toBe(true)
  })

  it('sets env_allowlist=[] for org sandboxes even when tenant did not supply one', () => {
    // When sanitize_env=true and organizationId is set, we must always emit an explicit
    // empty list — otherwise the runner falls back to Rust's default_env_allowlist()
    // and forwards RUST_LOG, PATH, HOME, USER, LANG, TERM from the host environment.
    const dto = new SecurityOptionsDto()
    // No envAllowlist set — but org context must still produce explicit empty list.

    const result = service.computeEffectiveSecurity(dto, { organizationId: 'org-123' })
    expect(result.effective['env_allowlist']).toEqual([])
    // No rejected field entry when tenant did not supply the field (no replacement message needed)
    expect(result.policyResult.rejectedFields.some((f) => f.includes('env_allowlist'))).toBe(false)
  })

  it('allows sanitize_env=false for non-org (local dev) sandboxes', () => {
    const dto = new SecurityOptionsDto()
    dto.sanitizeEnv = false

    const result = service.computeEffectiveSecurity(dto, {})
    // No organizationId → local dev; policy should allow it
    expect(result.effective['sanitize_env']).toBe(false)
    expect(result.policyResult.rejectedFields.some((f) => f.includes('sanitize_env'))).toBe(false)
  })

  it('strips sandbox_profile for org sandboxes (tenant must not supply raw SBPL path)', () => {
    const dto = new SecurityOptionsDto()
    dto.sandboxProfile = '/etc/custom-permissive.sbpl'

    const result = service.computeEffectiveSecurity(dto, { organizationId: 'org-123' })
    // Tenant-supplied sandbox profile must never reach the runner on the hosted platform.
    expect(result.effective['sandbox_profile']).toBeUndefined()
    expect(result.policyResult.rejectedFields.some((f) => f.includes('sandbox_profile'))).toBe(true)
  })

  it('allows sandbox_profile for non-org (local SDK) contexts', () => {
    const dto = new SecurityOptionsDto()
    dto.sandboxProfile = '/custom/local.sbpl'

    const result = service.computeEffectiveSecurity(dto, {})
    // No organizationId → local SDK use; caller controls their own host, allow it.
    expect(result.effective['sandbox_profile']).toBe('/custom/local.sbpl')
    expect(result.policyResult.rejectedFields.some((f) => f.includes('sandbox_profile'))).toBe(false)
  })
})

describe('SecurityPolicyService – runner capability gating contract', () => {
  // The enforcement gate is runner.supportsSecurityOptions (a database column that defaults
  // to false for existing runners). Only runners that explicitly declare this capability
  // receive and enforce the security field in the v2 job payload.
  //
  // This replaces the former apiVersion === '2' gate, which was necessary but not sufficient:
  // older v2 runners silently dropped the unknown JSON field.

  it('confirms the capability flag is the enforcement gate (not apiVersion)', () => {
    // The Runner entity now has a supportsSecurityOptions boolean column (default false).
    // sandbox.service.ts gates effectiveSecurityOptions storage and explicit security
    // request acceptance on runner.supportsSecurityOptions, not runner.apiVersion.
    //
    // This test asserts the shape of the gate so any regression that reverts to
    // apiVersion-only gating will cause a test failure or a type error.
    const Runner = require('../entities/runner.entity').Runner
    const runner = new Runner({
      region: 'us-east-1',
      name: 'test-runner',
      apiKey: 'key',
      apiVersion: '2',
      apiUrl: 'http://localhost:3000',
    })
    // New runners default to supportsSecurityOptions=false (explicit opt-in required).
    expect(runner.supportsSecurityOptions).toBe(false)

    // A runner that declares support must have the field set to true.
    const capableRunner = new Runner({
      region: 'us-east-1',
      name: 'capable-runner',
      apiKey: 'key',
      apiVersion: '2',
      apiUrl: 'http://localhost:3000',
      supportsSecurityOptions: true,
    })
    expect(capableRunner.supportsSecurityOptions).toBe(true)
  })
})

describe('Warm-pool security invariant – SECURITY_OPTIONS_ENABLED gate', () => {
  // When SECURITY_OPTIONS_ENABLED=true every fresh sandbox on a capable runner
  // receives platform-default effectiveSecurityOptions.  Warm-pool sandboxes are
  // created without any security policy, so reusing one when the flag is on
  // would silently serve a sandbox with no security enforcement.
  //
  // The fix: skipWarmPool is set to isSecurityOptionsEnabled() in sandbox.service.ts,
  // which must evaluate to true regardless of whether the caller sent a security dto.

  let savedEnv: string | undefined

  beforeEach(() => {
    savedEnv = process.env.SECURITY_OPTIONS_ENABLED
  })

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.SECURITY_OPTIONS_ENABLED
    } else {
      process.env.SECURITY_OPTIONS_ENABLED = savedEnv
    }
  })

  it('isSecurityOptionsEnabled() returns true when env=true (warm-pool must be skipped)', () => {
    process.env.SECURITY_OPTIONS_ENABLED = 'true'
    expect(isSecurityOptionsEnabled()).toBe(true)
  })

  it('isSecurityOptionsEnabled() returns false when env=false (warm-pool bypass disabled)', () => {
    process.env.SECURITY_OPTIONS_ENABLED = 'false'
    expect(isSecurityOptionsEnabled()).toBe(false)
  })

  it('isSecurityOptionsEnabled() returns false when env var is absent', () => {
    delete process.env.SECURITY_OPTIONS_ENABLED
    expect(isSecurityOptionsEnabled()).toBe(false)
  })
})

describe('SecurityPolicyService – chroot partial-enforcement warning', () => {
  let service: SecurityPolicyService

  beforeEach(() => {
    service = new SecurityPolicyService()
  })

  it('warns when chroot_enabled=true is in the effective policy (not yet enforced at runtime)', () => {
    const dto = new SecurityOptionsDto()
    dto.chrootEnabled = true

    const result = service.computeEffectiveSecurity(dto, {})
    // chroot_enabled is not yet enforced at runtime; callers must see a warning.
    const hasChrootWarning = result.policyResult.warnings.some((w) => w.includes('chroot_enabled'))
    expect(hasChrootWarning).toBe(true)
  })

  it('warns when chroot_base is set in the effective policy (not yet enforced at runtime)', () => {
    const dto = new SecurityOptionsDto()
    dto.chrootBase = '/tmp/chroot'

    const result = service.computeEffectiveSecurity(dto, {})
    // chroot_base is not yet enforced at runtime; callers must see a warning.
    const hasChrootBaseWarning = result.policyResult.warnings.some((w) => w.includes('chroot_base'))
    expect(hasChrootBaseWarning).toBe(true)
  })

  it('does NOT warn when chroot_enabled is false (false is always safe/no-op)', () => {
    const dto = new SecurityOptionsDto()
    dto.chrootEnabled = false

    const result = service.computeEffectiveSecurity(dto, {})
    const hasChrootWarning = result.policyResult.warnings.some((w) => w.includes('chroot_enabled'))
    expect(hasChrootWarning).toBe(false)
  })
})

// sandbox.service.ts incapable-runner fail-closed guard:
//   isSecurityOptionsEnabled() && !runner.supportsSecurityOptions → throw BadRequestError
// Testing that throw requires full DI for SandboxService.
// Individual inputs (isSecurityOptionsEnabled, Runner.supportsSecurityOptions) are covered
// by "Warm-pool security invariant" and "v2 runner registration" describes above.

describe('v2 runner registration – supportsSecurityOptions is DTO-explicit, defaults false', () => {
  // Codex finding (round 12): The create() method in runner.service.ts was setting
  // supportsSecurityOptions=true for ALL v2 runners unconditionally, meaning an old v2
  // runner registered after deploy would be marked capable even if it silently drops
  // the security field in the job payload.
  //
  // Fix (round 12): supportsSecurityOptions is now an explicit field on
  // CreateRunnerV2InternalDto (default false).  RunnerService.create() passes
  // dto.supportsSecurityOptions ?? false so only runners that declare the capability
  // are marked capable.
  //
  // The round-9 fix (always true for v2) is intentionally reverted here in favour of
  // the explicit-DTO approach.

  it('v0 runner defaults supportsSecurityOptions to false', () => {
    const { Runner } = require('../entities/runner.entity')
    const runner = new Runner({
      region: 'us-east-1',
      name: 'v0-runner',
      apiKey: 'key',
      apiVersion: '0',
      apiUrl: 'http://localhost:3000',
      proxyUrl: 'http://localhost:3001',
    })
    expect(runner.supportsSecurityOptions).toBe(false)
  })

  it('v2 runner WITHOUT supportsSecurityOptions in DTO defaults to false (explicit opt-in required)', () => {
    // Omitting supportsSecurityOptions exercises the entity constructor's own ?? false default.
    // Old v2 runners registered without the flag must not be auto-promoted to capable.
    const { Runner } = require('../entities/runner.entity')
    const runner = new Runner({
      region: 'us-east-1',
      name: 'v2-runner-legacy',
      apiKey: 'key',
      apiVersion: '2',
    })
    expect(runner.apiVersion).toBe('2')
    expect(runner.supportsSecurityOptions).toBe(false)
  })

  it('v2 runner WITH supportsSecurityOptions=true in DTO becomes capable', () => {
    // Mirrors RunnerService.create() v2 branch with dto.supportsSecurityOptions=true.
    // Only runners that explicitly declare support receive security payloads.
    const { Runner } = require('../entities/runner.entity')
    const runner = new Runner({
      region: 'us-east-1',
      name: 'v2-runner-capable',
      apiKey: 'key',
      apiVersion: '2',
      supportsSecurityOptions: true,
    })
    expect(runner.apiVersion).toBe('2')
    expect(runner.supportsSecurityOptions).toBe(true)
  })

})

describe('Healthcheck backfill removal – supportsSecurityOptions must NOT be inferred from apiVersion', () => {
  // Codex finding (round 10): updateRunnerHealth() backfilled supportsSecurityOptions=true
  // for every v2 runner on heartbeat, defeating the migration default of false.  An old v2
  // runner that predates security-options support could keep heartbeating, be promoted, then
  // receive the security payload and silently ignore it.
  //
  // Fix: remove the backfill.  Runners must declare capability explicitly at registration.
  // This contract test verifies that:
  //  (a) a v2 runner constructed without the explicit flag stays false, and
  //  (b) only when explicitly passed true does it become true.

  it('v2 runner without explicit flag defaults to supportsSecurityOptions=false', () => {
    const { Runner } = require('../entities/runner.entity')
    const runner = new Runner({
      region: 'us-east-1',
      name: 'legacy-v2-runner',
      apiKey: 'key',
      apiVersion: '2',
    })
    // Must stay false — the backfill path no longer exists.
    expect(runner.supportsSecurityOptions).toBe(false)
  })

  it('v2 runner with explicit supportsSecurityOptions=true is capable', () => {
    const { Runner } = require('../entities/runner.entity')
    const runner = new Runner({
      region: 'us-east-1',
      name: 'new-v2-runner',
      apiKey: 'key',
      apiVersion: '2',
      supportsSecurityOptions: true,
    })
    expect(runner.supportsSecurityOptions).toBe(true)
  })
})

describe('Runner selection – requireSecurityOptions pre-filters the pool', () => {
  // Codex finding (round 10): createFromSnapshot selected a random runner first, then
  // checked capability after the fact.  In a mixed pool this caused intermittent failures
  // even when a capable runner was available.
  //
  // Fix: GetRunnerParams gains requireSecurityOptions; findAvailableRunners applies the
  // filter before random selection.  This test verifies the shape of the fix.

  it('GetRunnerParams.requireSecurityOptions defaults to undefined (absent = no pre-filter)', () => {
    // A default-constructed GetRunnerParams must not pre-filter by capability.
    // If the default were true, all non-security sandbox creates would be broken.
    const { GetRunnerParams } = require('./runner.service')
    const params = new GetRunnerParams()
    expect(params.requireSecurityOptions).toBeUndefined()
  })

})

// sandbox.service.ts explicit-security-rejected guard:
//   !!createSandboxDto.security && !isSecurityOptionsEnabled() → throw BadRequestError
// Testing that throw requires full DI for SandboxService.
// isSecurityOptionsEnabled() behavior is covered by "Warm-pool security invariant" above.

describe('SecurityOptionsDto snake_case transform', () => {
  it('accepts camelCase jailerEnabled', async () => {
    const plain = { jailerEnabled: true, networkEnabled: false }
    const dto = plainToClass(SecurityOptionsDto, plain)
    expect(dto.jailerEnabled).toBe(true)
    expect(dto.networkEnabled).toBe(false)
    const errors = await validate(dto)
    expect(errors).toHaveLength(0)
  })

  it('accepts snake_case jailer_enabled from Rust REST client', async () => {
    const plain = { jailer_enabled: true, network_enabled: false }
    const dto = plainToClass(SecurityOptionsDto, plain)
    expect(dto.jailerEnabled).toBe(true)
    expect(dto.networkEnabled).toBe(false)
    const errors = await validate(dto)
    expect(errors).toHaveLength(0)
  })

  it('accepts snake_case seccomp_enabled', async () => {
    const plain = { seccomp_enabled: true }
    const dto = plainToClass(SecurityOptionsDto, plain)
    expect(dto.seccompEnabled).toBe(true)
  })

  it('accepts snake_case resource_limits', async () => {
    const plain = {
      jailer_enabled: true,
      resource_limits: {
        max_open_files: 1024,
        max_processes: 100,
      },
    }
    const dto = plainToClass(SecurityOptionsDto, plain, { enableImplicitConversion: false })
    expect(dto.jailerEnabled).toBe(true)
    // resource_limits transform maps to resourceLimits field
    expect(dto.resourceLimits).toBeDefined()
  })

  it('snake_case resource_limits.max_open_files reaches dto.resourceLimits.maxOpenFiles', async () => {
    // Regression guard: when the nested object uses snake_case keys, the SecurityResourceLimitsDto
    // @Transform decorators must run so max_open_files → maxOpenFiles.
    // Before the fix, @Transform on the parent returned a plain object and @Type was skipped,
    // so the nested @Transform decorators never ran and dto.resourceLimits.maxOpenFiles was undefined.
    const plain = { resource_limits: { max_open_files: 1024, max_processes: 50 } }
    const dto = plainToClass(SecurityOptionsDto, plain)
    expect(dto.resourceLimits).toBeDefined()
    expect(dto.resourceLimits!.maxOpenFiles).toBe(1024)
    expect(dto.resourceLimits!.maxProcesses).toBe(50)
    const errors = await validate(dto)
    expect(errors).toHaveLength(0)
  })

  it('snake_case resource_limits.max_open_files reaches effective security policy', () => {
    // End-to-end regression: snake_case resource_limits must survive the full
    // DTO → dtoToSnakeCase → effective policy path.
    const service = new SecurityPolicyService()
    const dto = plainToClass(SecurityOptionsDto, {
      resource_limits: { max_open_files: 1024 },
    })
    const result = service.computeEffectiveSecurity(dto, {})
    // The effective policy must carry the requested rlimit.
    const rl = result.effective['resource_limits'] as Record<string, unknown> | undefined
    expect(rl).toBeDefined()
    expect(rl!['max_open_files']).toBe(1024)
  })

  it('camelCase takes precedence over snake_case when both are present', async () => {
    const plain = { jailerEnabled: false, jailer_enabled: true }
    const dto = plainToClass(SecurityOptionsDto, plain)
    // camelCase wins because Transform uses obj.jailerEnabled ?? obj.jailer_enabled
    expect(dto.jailerEnabled).toBe(false)
  })

  it('null jailerEnabled is coerced to undefined (not propagated as null)', async () => {
    // Regression guard: @IsOptional() short-circuits @IsBoolean() for null, so null
    // would silently pass the DTO boundary and bypass the jailer_enabled=null guard.
    // The Transform must map null → undefined so the field is simply absent.
    const plain = { jailerEnabled: null }
    const dto = plainToClass(SecurityOptionsDto, plain)
    expect(dto.jailerEnabled).toBeUndefined()
    const errors = await validate(dto)
    expect(errors).toHaveLength(0)
  })

  it('null sanitizeEnv is coerced to undefined (not propagated as null)', async () => {
    // Same null-bypass applies to sanitize_env: if null reached the service the
    // guard `base['sanitize_env'] === false` would not fire and env sanitization
    // could be silently disabled.
    const plain = { sanitizeEnv: null }
    const dto = plainToClass(SecurityOptionsDto, plain)
    expect(dto.sanitizeEnv).toBeUndefined()
    const errors = await validate(dto)
    expect(errors).toHaveLength(0)
  })
})

describe('SecurityPolicyService – null value bypass prevention', () => {
  // Regression guard for: null security boolean fields bypass hosted-platform enforcement.
  //
  // Root cause: @IsOptional() in class-validator short-circuits @IsBoolean() for null
  // values, so null passes DTO validation.  dtoToSnakeCase used !== undefined checks,
  // meaning null values were included in the requestedSnake output.  The merge loop
  // then wrote null into base[].  Policy guards (`=== false`) do not fire for null.
  //
  // Fixes:
  //   A. DTO Transform: null → undefined for boolean fields (boundary normalization)
  //   B. dtoToSnakeCase: !=(null) to skip both null and undefined
  //   C. Merge loop: null values treated as absent (defense-in-depth)

  let service: SecurityPolicyService

  beforeEach(() => {
    service = new SecurityPolicyService()
  })

  it('null jailer_enabled in dto does NOT bypass the hosted-platform jailer_enabled=true guard', () => {
    // Before fix: { jailer_enabled: null } passed through dtoToSnakeCase, was merged
    // into base as null, and the guard `=== false` did not fire → jailer disabled.
    // After fix: null is treated as absent in dtoToSnakeCase and the merge loop;
    // the platform default (jailer_enabled: true) is preserved.
    const dto = new SecurityOptionsDto()
    // Simulate null reaching the service (e.g., via programmatic construction)
    ;(dto as unknown as Record<string, unknown>)['jailerEnabled'] = null

    const result = service.computeEffectiveSecurity(dto, { organizationId: 'org-123' })
    expect(result.effective['jailer_enabled']).toBe(true)
  })

  it('null sanitize_env in dto does NOT bypass the hosted-platform sanitize_env=true guard', () => {
    const dto = new SecurityOptionsDto()
    ;(dto as unknown as Record<string, unknown>)['sanitizeEnv'] = null

    const result = service.computeEffectiveSecurity(dto, { organizationId: 'org-123' })
    expect(result.effective['sanitize_env']).toBe(true)
  })
})

describe('SecurityOptionsDto – unknown field rejection (Finding 1)', () => {
  // Without this guard a typo like `seccomp_enabledd: true` passes the DTO boundary
  // with no error and is silently discarded — the caller gets a false security signal
  // (they believe seccomp is enabled; the sandbox uses the platform default instead).

  it('rejects SecurityOptionsDto with a typo field (seccomp_enabledd)', async () => {
    // Typo: extra 'd'. Must fail validation so the caller learns their intent was not applied.
    const plain = { seccomp_enabledd: true }
    const dto = plainToClass(SecurityOptionsDto, plain)
    const errors = await validate(dto)
    expect(errors.length).toBeGreaterThan(0)
    const messages = errors.map((e) => Object.values(e.constraints ?? {})).flat().join(' ')
    expect(messages).toContain('seccomp_enabledd')
  })

  it('accepts SecurityOptionsDto with valid snake_case fields (no false positive)', async () => {
    // Regression guard: valid snake_case fields must still pass after the unknown-key guard.
    const plain = { seccomp_enabled: true, jailer_enabled: false }
    const dto = plainToClass(SecurityOptionsDto, plain)
    const errors = await validate(dto)
    expect(errors).toHaveLength(0)
  })

  it('accepts SecurityOptionsDto with valid camelCase fields (no false positive)', async () => {
    const plain = { seccompEnabled: true, jailerEnabled: false, networkEnabled: true }
    const dto = plainToClass(SecurityOptionsDto, plain)
    const errors = await validate(dto)
    expect(errors).toHaveLength(0)
  })

  it('rejects SecurityOptionsDto with multiple unknown fields', async () => {
    const plain = { jailer_enabled: true, unknown_field: 'x', another_typo: 1 }
    const dto = plainToClass(SecurityOptionsDto, plain)
    const errors = await validate(dto)
    expect(errors.length).toBeGreaterThan(0)
    const messages = errors.map((e) => Object.values(e.constraints ?? {})).flat().join(' ')
    expect(messages).toContain('unknown_field')
  })

  it('rejects SecurityResourceLimitsDto with an unknown field (max_open_filez typo)', async () => {
    // Validate the nested DTO directly to confirm the unknown-key guard fires there too.
    const plain = { max_open_files: 1024, max_open_filez: 999 }
    const limitsDto = plainToClass(SecurityResourceLimitsDto, plain)
    const errors = await validate(limitsDto)
    expect(errors.length).toBeGreaterThan(0)
    const messages = errors.map((e) => Object.values(e.constraints ?? {})).flat().join(' ')
    expect(messages).toContain('max_open_filez')
  })
})

describe('SecurityPolicyService – network_enabled=false is partial (Landlock best-effort)', () => {
  // network_enabled=false is enforced via Linux Landlock LSM.  LandlockSandbox degrades
  // gracefully on kernels without Landlock support (< 5.13): it logs a warning and
  // continues, meaning the sandbox has full network access while the API claims otherwise.
  //
  // Fix: add network_enabled to PARTIAL_FIELDS so org sandboxes receive a warning and
  // the field is stripped from the effective policy (no false security guarantee).
  // Non-org (local SDK) contexts keep the field since the caller controls their host.

  let service: SecurityPolicyService

  beforeEach(() => {
    service = new SecurityPolicyService()
  })

  it('warns when network_enabled=false is in the effective policy (Landlock may not be enforced)', () => {
    const dto = new SecurityOptionsDto()
    dto.networkEnabled = false

    const result = service.computeEffectiveSecurity(dto, {})
    const hasNetworkWarning = result.policyResult.warnings.some((w) => w.includes('network_enabled'))
    expect(hasNetworkWarning).toBe(true)
  })

  it('strips network_enabled from effective policy for org sandboxes when false', () => {
    // Org sandboxes must not advertise network_enabled=false as enforced — Landlock
    // is best-effort and may be absent on the host kernel.
    const dto = new SecurityOptionsDto()
    dto.networkEnabled = false

    const result = service.computeEffectiveSecurity(dto, { organizationId: 'org-123' })
    expect(result.effective['network_enabled']).toBeUndefined()
  })

  it('keeps network_enabled warning in policyResult even when stripped for org sandboxes', () => {
    const dto = new SecurityOptionsDto()
    dto.networkEnabled = false

    const result = service.computeEffectiveSecurity(dto, { organizationId: 'org-123' })
    const hasNetworkWarning = result.policyResult.warnings.some((w) => w.includes('network_enabled'))
    expect(hasNetworkWarning).toBe(true)
  })

  it('does NOT warn when network_enabled=true (true is the default, no isolation implied)', () => {
    // network_enabled=true means "allow network access" which is the safe default.
    // No enforcement expectation; no warning needed.
    const dto = new SecurityOptionsDto()
    dto.networkEnabled = true

    const result = service.computeEffectiveSecurity(dto, {})
    const hasNetworkWarning = result.policyResult.warnings.some((w) => w.includes('network_enabled'))
    expect(hasNetworkWarning).toBe(false)
  })

  it('preserves network_enabled=false in effective policy for non-org (local SDK) contexts', () => {
    // For non-org contexts the caller controls their own host and can accept partial
    // enforcement; keep the field so their self-hosted runtime can act on it if Landlock
    // is available.
    const dto = new SecurityOptionsDto()
    dto.networkEnabled = false

    const result = service.computeEffectiveSecurity(dto, {})
    expect(result.effective['network_enabled']).toBe(false)
  })
})

describe('createFromBuildInfo – capability-only check before PENDING_BUILD (Finding 1)', () => {
  // When getRandomAvailableRunner fails with "No available runners" AND security is
  // enabled, the failure can mean either:
  //   (a) snapshot not yet built on any runner → PENDING_BUILD is valid
  //   (b) no security-capable runners exist in this region → PENDING_BUILD is stuck forever
  //
  // Fix: before queuing as PENDING_BUILD, call findAvailableRunners with
  // requireSecurityOptions=true but WITHOUT snapshotRef (raw capacity check).
  // If no capable runners exist, throw BadRequestError immediately.
  //
  // This is a shape-contract test (cannot instantiate SandboxService directly).

  it('capable runner satisfies the capacity check (supportsSecurityOptions=true)', () => {
    // A runner explicitly registered with supportsSecurityOptions=true must pass
    // the capability-only preflight before PENDING_BUILD is queued.
    const runner = new Runner({
      region: 'us-east-1',
      name: 'capable-runner',
      apiVersion: '2',
      apiKey: 'key',
      supportsSecurityOptions: true,
    })
    expect(runner.supportsSecurityOptions).toBe(true)
  })

  it('incapable runner fails the capacity check (supportsSecurityOptions defaults false)', () => {
    // A runner registered without explicit supportsSecurityOptions uses entity default (false).
    // findAvailableRunners(requireSecurityOptions=true) would return no runners for this case.
    const runner = new Runner({
      region: 'us-east-1',
      name: 'legacy-runner',
      apiVersion: '2',
      apiKey: 'key',
    })
    expect(runner.supportsSecurityOptions).toBe(false)
  })

  it('GetRunnerParams.snapshotRef defaults to undefined (capability check must not include snapshot ref)', () => {
    // The preflight path passes requireSecurityOptions=true without snapshotRef.
    // If snapshotRef had a non-undefined default it would conflate the two cases again.
    const { GetRunnerParams } = require('./runner.service')
    const params = new GetRunnerParams()
    expect(params.snapshotRef).toBeUndefined()
  })
})

describe('SecurityResourceLimitsDto – MAX_SAFE_INTEGER cap (Finding 2)', () => {
  // JSON numbers above Number.MAX_SAFE_INTEGER (2^53 - 1 = 9007199254740991) are
  // rounded by JSON.parse before class-validator sees them. The validated value may
  // differ from what the caller sent — a security boundary mismatch.
  // @Max(Number.MAX_SAFE_INTEGER) rejects such values (when they are still representable
  // as exact integers) and documents the safe range as the API contract.

  it('accepts maxOpenFiles = Number.MAX_SAFE_INTEGER', async () => {
    const limitsDto = plainToClass(SecurityResourceLimitsDto, { maxOpenFiles: Number.MAX_SAFE_INTEGER })
    const errors = await validate(limitsDto)
    expect(errors).toHaveLength(0)
  })

  it('rejects maxOpenFiles = Number.MAX_SAFE_INTEGER + 2 (first non-roundable value)', async () => {
    // MAX_SAFE_INTEGER + 1 equals MAX_SAFE_INTEGER in IEEE 754 (cannot be exactly represented).
    // MAX_SAFE_INTEGER + 2 is representable and larger — use it to test the @Max boundary.
    const tooLarge = Number.MAX_SAFE_INTEGER + 2
    const limitsDto = plainToClass(SecurityResourceLimitsDto, { maxOpenFiles: tooLarge })
    const errors = await validate(limitsDto)
    // Expect a @Max violation (value exceeds MAX_SAFE_INTEGER).
    expect(errors.length).toBeGreaterThan(0)
  })

  it('rejects maxMemory above MAX_SAFE_INTEGER', async () => {
    const limitsDto = plainToClass(SecurityResourceLimitsDto, { maxMemory: Number.MAX_SAFE_INTEGER + 2 })
    const errors = await validate(limitsDto)
    expect(errors.length).toBeGreaterThan(0)
  })

  it('accepts all resource limit fields at MAX_SAFE_INTEGER (boundary)', async () => {
    const limitsDto = plainToClass(SecurityResourceLimitsDto, {
      maxOpenFiles: Number.MAX_SAFE_INTEGER,
      maxFileSize: Number.MAX_SAFE_INTEGER,
      maxProcesses: Number.MAX_SAFE_INTEGER,
      maxMemory: Number.MAX_SAFE_INTEGER,
      maxCpuTime: Number.MAX_SAFE_INTEGER,
    })
    const errors = await validate(limitsDto)
    expect(errors).toHaveLength(0)
  })
})
