// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { execFileSync, spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parseFlag } from './cli-flags.mjs'
import { resolveAwsCliPath } from './proxy-deployment-verify.mjs'
import {
  RUNTIME_SECRET_DEFINITIONS,
  STALE_SST_SECRET_NAMES,
  TRACKED_SST_SECRET_NAMES,
  runtimeSecretName,
} from './runtime-secrets.mjs'
import {
  sendCommand,
  verifyRunnerCommandTargets,
  waitForTerminalStatus,
} from './runner-update-binary.mjs'
import runnerInstanceIdentity from './runner-instance-identity.cjs'
import { SstSecretStatusStore } from './sst-secret-status.mjs'

const { parseEc2InstanceId } = runnerInstanceIdentity

const REGION_PATTERN = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/
const SST_WRAPPER_PATH = fileURLToPath(new URL('./sst-with-cloudflare.mjs', import.meta.url))

function requiredFlag(args, name) {
  const value = parseFlag(args, name)
  if (!value) throw new Error(`--${name} is required`)
  return value
}

function validateRegion(region) {
  if (!REGION_PATTERN.test(region)) throw new Error(`invalid AWS region '${region}'`)
  return region
}

function hasCurrentVersion(description) {
  const versions = description?.VersionIdsToStages
  if (!versions || typeof versions !== 'object' || Array.isArray(versions)) return false
  return Object.values(versions).some(
    (stages) => Array.isArray(stages) && stages.some((stage) => stage === 'AWSCURRENT'),
  )
}

function describeSecretWithoutValue({ awsCliPath, name, region }) {
  try {
    const output = execFileSync(
      awsCliPath,
      ['secretsmanager', 'describe-secret', '--region', region, '--secret-id', name, '--output', 'json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000, killSignal: 'SIGTERM' },
    )
    try {
      return JSON.parse(output)
    } catch (cause) {
      throw new Error(`AWS returned invalid metadata for ${name}`, { cause })
    }
  } catch (error) {
    const stderr = String(error.stderr ?? '')
    if (stderr.includes('ResourceNotFoundException')) return undefined
    if (error.message?.startsWith('AWS returned invalid metadata')) throw error
    throw new Error(`could not inspect runtime secret ${name} without reading its value`, { cause: error })
  }
}

function printStatus(args) {
  const stage = requiredFlag(args, 'stage')
  const region = validateRegion(requiredFlag(args, 'region'))
  const awsCliPath = resolveAwsCliPath()

  for (const { id } of RUNTIME_SECRET_DEFINITIONS) {
    const name = runtimeSecretName(stage, id)
    const description = describeSecretWithoutValue({ awsCliPath, name, region })
    console.log(`${name} ${hasCurrentVersion(description) ? 'SET' : 'UNSET'}`)
  }
  const statusStore = new SstSecretStatusStore({ awsCliPath, region })
  for (const name of TRACKED_SST_SECRET_NAMES) {
    console.log(`${name} ${statusStore.read({ stage, name })}`)
  }
}

function removeStale(args) {
  const stage = requiredFlag(args, 'stage')
  // Validate the stage with the same boundary used for stable runtime names.
  runtimeSecretName(stage, RUNTIME_SECRET_DEFINITIONS[0].id)
  const name = requiredFlag(args, 'name')
  const confirmation = requiredFlag(args, 'confirm')

  if (!STALE_SST_SECRET_NAMES.includes(name)) {
    throw new Error(`${name} is not in the stale SST secret allowlist`)
  }
  if (confirmation !== name) {
    throw new Error('--confirm must exactly match --name')
  }

  const result = spawnSync(
    process.execPath,
    [SST_WRAPPER_PATH, 'secret', 'remove', name, '--stage', stage, '--confirm', confirmation],
    {
      stdio: 'inherit',
      env: process.env,
    },
  )
  if (result.error) throw new Error(`failed to launch SST secret removal: ${result.error.message}`)
  if (result.signal) throw new Error(`SST secret removal terminated by ${result.signal}`)
  if (result.status !== 0) throw new Error(`SST secret removal failed with exit code ${result.status}`)
}

function requiredEnvironment(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

const SECRETS_MANAGER_ARN_PATTERN =
  /^arn:[A-Za-z0-9-]+:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$/

function validateSecretsManagerArn(name, arn) {
  if (!SECRETS_MANAGER_ARN_PATTERN.test(arn)) throw new Error(`${name} must be a Secrets Manager ARN`)
  return arn
}

export function buildExtraRunnerGhcrMigration({
  region,
  legacyGhcrSecretArn,
  ghcrSecretArn,
  ghcrEnabled,
  ghcrUsername,
}) {
  if (typeof ghcrEnabled !== 'boolean') throw new Error('ghcrEnabled must be a boolean')
  if (ghcrEnabled && !/^[A-Za-z0-9_.-]+$/.test(ghcrUsername)) {
    throw new Error('ghcrUsername is required when GHCR is enabled')
  }
  if (!ghcrEnabled && ghcrUsername !== '') {
    throw new Error('ghcrUsername must be empty when GHCR is disabled')
  }
  const legacyGhcrArnBase64 = Buffer.from(legacyGhcrSecretArn).toString('base64')
  const ghcrArnBase64 = Buffer.from(ghcrSecretArn).toString('base64')
  const stableSecretPreflight = ghcrEnabled
    ? `# The shared instance role update and its IMDS credentials converge
# asynchronously. Prove the target secret is readable before touching files.
for i in $(seq 1 30); do
  GHCR_TOKEN=$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$GHCR_SECRET_ARN" --query SecretString --output text 2>/dev/null || true)
  { [ -n "$GHCR_TOKEN" ] && [ "$GHCR_TOKEN" != "None" ] && [ "$GHCR_TOKEN" != "unused" ]; } && break
  [ "$i" -eq 30 ] || sleep 10
done
if [ -z "$GHCR_TOKEN" ] || [ "$GHCR_TOKEN" = "None" ] || [ "$GHCR_TOKEN" = "unused" ]; then
  echo "FATAL: target GHCR credential was not readable after the role propagation window" >&2
  exit 1
fi
unset GHCR_TOKEN`
    : ''
  const updateDropIn = ghcrEnabled
    ? `mkdir -p "$DROPIN_DIR"
cat > "$DROPIN" << DROPIN
[Service]
UnsetEnvironment=GHCR_TOKEN
Environment=GHCR_SECRET_ARN=${ghcrSecretArn}
Environment=GHCR_USERNAME=${ghcrUsername}
ExecStart=
ExecStart=/usr/local/bin/boxlite-runner-start.sh
DROPIN`
    : 'rm -f "$DROPIN"'
  const verifyDropIn = ghcrEnabled
    ? `grep -Fqx "$STABLE_GHCR_LINE" "$DROPIN" &&
grep -Fqx "Environment=GHCR_USERNAME=${ghcrUsername}" "$DROPIN" &&
grep -Fqx "ExecStart=/usr/local/bin/boxlite-runner-start.sh" "$DROPIN" || {
  echo "FATAL: target GHCR ARN drop-in was not installed" >&2
  exit 1
}`
    : `[ ! -f "$DROPIN" ] || {
  echo "FATAL: GHCR ARN drop-in remains while GHCR is disabled" >&2
  exit 1
}`

  return `set -euo pipefail
UNIT=/etc/systemd/system/boxlite-runner.service
WRAPPER=/usr/local/bin/boxlite-runner-start.sh
DROPIN_DIR=/etc/systemd/system/boxlite-runner.service.d
DROPIN=$DROPIN_DIR/ghcr-runtime-secret.conf
AWS_REGION=${region}
LEGACY_GHCR_SECRET_ARN=$(printf '%s' '${legacyGhcrArnBase64}' | base64 -d)
GHCR_SECRET_ARN=$(printf '%s' '${ghcrArnBase64}' | base64 -d)
LEGACY_GHCR_LINE="Environment=GHCR_SECRET_ARN=$LEGACY_GHCR_SECRET_ARN"
STABLE_GHCR_LINE="Environment=GHCR_SECRET_ARN=$GHCR_SECRET_ARN"

for _ in $(seq 1 60); do
  [ -f "$UNIT" ] && systemctl is-enabled --quiet boxlite-runner 2>/dev/null && break
  sleep 5
done
[ -f "$UNIT" ] || { echo "FATAL: runner unit is not installed" >&2; exit 1; }
[ ! -e "$WRAPPER" ] || { [ -f "$WRAPPER" ] && [ ! -L "$WRAPPER" ]; } || {
  echo "FATAL: runner start wrapper path is not a regular file" >&2
  exit 1
}

# The per-runner token remains in the protected instance's existing unit. Prove
# this transaction neither removes nor rewrites its exact line without ever
# printing or passing that value through the deployer.
TOKEN_LINE_COUNT_BEFORE=$(grep -c '^Environment=BOXLITE_RUNNER_TOKEN=' "$UNIT" || true)
[ "$TOKEN_LINE_COUNT_BEFORE" -eq 1 ] || {
  echo "FATAL: expected exactly one existing per-runner token line" >&2
  exit 1
}
TOKEN_LINE_DIGEST_BEFORE=$(grep '^Environment=BOXLITE_RUNNER_TOKEN=' "$UNIT" | sha256sum | awk '{print $1}')

${stableSecretPreflight}

WORK=$(mktemp -d)
chmod 0700 "$WORK"
cp -a "$UNIT" "$WORK/unit"
WRAPPER_EXISTED=false
if [ -f "$WRAPPER" ]; then
  cp -a "$WRAPPER" "$WORK/wrapper"
  WRAPPER_EXISTED=true
fi
DROPIN_DIR_EXISTED=false
[ ! -d "$DROPIN_DIR" ] || DROPIN_DIR_EXISTED=true
[ ! -f "$DROPIN" ] || cp -a "$DROPIN" "$WORK/dropin"
CACHE_BACKUP_INDEX=$WORK/cloud-cache-backups
: > "$CACHE_BACKUP_INDEX"
COMMITTED=false
rollback() {
  status=$?
  if [ "$COMMITTED" != true ]; then
    cp -a "$WORK/unit" "$UNIT"
    if [ "$WRAPPER_EXISTED" = true ]; then cp -a "$WORK/wrapper" "$WRAPPER"; else rm -f "$WRAPPER"; fi
    mkdir -p "$DROPIN_DIR"
    if [ -f "$WORK/dropin" ]; then cp -a "$WORK/dropin" "$DROPIN"; else rm -f "$DROPIN"; fi
    while IFS= read -r -d '' cache_backup && IFS= read -r -d '' cache_file; do
      cp -a "$cache_backup" "$cache_file"
    done < "$CACHE_BACKUP_INDEX"
    if [ "$DROPIN_DIR_EXISTED" != true ]; then rmdir "$DROPIN_DIR" 2>/dev/null || true; fi
    systemctl daemon-reload
    systemctl restart boxlite-runner || true
  fi
  rm -rf "$WORK"
  exit "$status"
}
trap rollback EXIT

# Canonical wrapper is deliberately optional: enabling GHCR overrides ExecStart
# to it through the managed drop-in; disabling removes that drop-in. Historical
# units that already point here continue safely because an absent ARN skips the
# credential fetch and directly execs the Runner with its inherited token.
cat > "$WRAPPER" << 'STARTWRAP'
#!/bin/bash
set -euo pipefail
if [ -n "\${GHCR_SECRET_ARN:-}" ]; then
  for i in 1 2 3 4 5; do
    GHCR_TOKEN=$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$GHCR_SECRET_ARN" --query SecretString --output text 2>/dev/null || true)
    { [ -n "$GHCR_TOKEN" ] && [ "$GHCR_TOKEN" != "None" ] && [ "$GHCR_TOKEN" != "unused" ]; } && break
    echo "ghcr token fetch attempt $i failed; retrying in $((i*5))s" >&2
    sleep $((i*5))
  done
  if [ -z "\${GHCR_TOKEN:-}" ] || [ "$GHCR_TOKEN" = "None" ] || [ "$GHCR_TOKEN" = "unused" ]; then
    echo "FATAL: could not fetch ghcr pull token; refusing anonymous pulls" >&2
    exit 1
  fi
  export GHCR_TOKEN
fi
exec /usr/local/bin/boxlite-runner
STARTWRAP
chmod 0755 "$WRAPPER"

scrub_known_ghcr_lines() {
  file=$1
  rewritten=$2
  if ! grep -Fqx "$LEGACY_GHCR_LINE" "$file" &&
    ! grep -Fqx "$STABLE_GHCR_LINE" "$file" &&
    ! grep -q '^Environment=GHCR_USERNAME=' "$file"; then
    return 0
  fi
  file_owner=$(stat -c '%u:%g' "$file")
  file_mode=$(stat -c '%a' "$file")
  awk -v legacy="$LEGACY_GHCR_LINE" -v stable="$STABLE_GHCR_LINE" \
    '$0 != legacy && $0 != stable && $0 !~ /^Environment=GHCR_USERNAME=/ { print }' "$file" > "$rewritten"
  cat "$rewritten" > "$file"
  chown "$file_owner" "$file"
  chmod "$file_mode" "$file"
}

scrub_known_ghcr_lines "$UNIT" "$WORK/unit-rewritten"

# cloud-init retains decoded copies of historical EC2 user-data on disk. Remove
# only the exact known GHCR ARN lines, retaining the per-runner token and every
# other byte. Metadata-preserving backups participate in the same rollback.
cache_number=0
for cache_file in /var/lib/cloud/instances/*/user-data.txt /var/lib/cloud/instances/*/scripts/part-001; do
  [ -f "$cache_file" ] || continue
  if ! grep -Fqx "$LEGACY_GHCR_LINE" "$cache_file" &&
    ! grep -Fqx "$STABLE_GHCR_LINE" "$cache_file" &&
    ! grep -q '^Environment=GHCR_USERNAME=' "$cache_file"; then
    continue
  fi
  cache_backup=$WORK/cloud-cache-$cache_number
  cp -a "$cache_file" "$cache_backup"
  printf '%s\\0%s\\0' "$cache_backup" "$cache_file" >> "$CACHE_BACKUP_INDEX"
  scrub_known_ghcr_lines "$cache_file" "$WORK/cloud-cache-rewritten-$cache_number"
  cache_number=$((cache_number + 1))
done

${updateDropIn}

TOKEN_LINE_COUNT_AFTER=$(grep -c '^Environment=BOXLITE_RUNNER_TOKEN=' "$UNIT" || true)
TOKEN_LINE_DIGEST_AFTER=$(grep '^Environment=BOXLITE_RUNNER_TOKEN=' "$UNIT" | sha256sum | awk '{print $1}')
if [ "$TOKEN_LINE_COUNT_AFTER" -ne 1 ] || [ "$TOKEN_LINE_DIGEST_AFTER" != "$TOKEN_LINE_DIGEST_BEFORE" ]; then
  echo "FATAL: per-runner token line changed during GHCR reconciliation" >&2
  exit 1
fi
for current_file in "$UNIT" /var/lib/cloud/instances/*/user-data.txt /var/lib/cloud/instances/*/scripts/part-001; do
  [ -f "$current_file" ] || continue
  if grep -Fqx "$LEGACY_GHCR_LINE" "$current_file" ||
    grep -Fqx "$STABLE_GHCR_LINE" "$current_file" ||
    grep -q '^Environment=GHCR_USERNAME=' "$current_file"; then
    echo "FATAL: GHCR configuration remains outside the managed drop-in after reconciliation" >&2
    exit 1
  fi
done
${verifyDropIn}

systemctl daemon-reload
systemctl restart boxlite-runner
systemctl is-active --quiet boxlite-runner
COMMITTED=true
echo "extra runner GHCR runtime-secret state reconciled"
`
}

// A rollback runs after Pulumi has moved an extra Runner back to the retained
// historical profile. Reuse the same transactional host reconciler with the
// direction reversed: scrub the stable reference and restore the legacy one.
// Disabled GHCR still removes both references and never reads either secret.
export function buildExtraRunnerGhcrLegacyRollback({
  region,
  stableGhcrSecretArn,
  legacyGhcrSecretArn,
  ghcrEnabled,
  ghcrUsername,
}) {
  return buildExtraRunnerGhcrMigration({
    region,
    legacyGhcrSecretArn: stableGhcrSecretArn,
    ghcrSecretArn: legacyGhcrSecretArn,
    ghcrEnabled,
    ghcrUsername,
  })
}

export function buildDefaultRunnerSecretMigration({ region, runnerTokenSecretArn, ghcrSecretArn, ghcrUsername }) {
  const runnerTokenArnBase64 = Buffer.from(runnerTokenSecretArn).toString('base64')
  const ghcrArnBase64 = Buffer.from(ghcrSecretArn).toString('base64')
  const ghcrUsernameBase64 = Buffer.from(ghcrUsername).toString('base64')
  const ghcrPreflight = ghcrUsername
    ? `
for i in $(seq 1 30); do
  GHCR_TOKEN=$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$GHCR_SECRET_ARN" --query SecretString --output text 2>/dev/null || true)
  { [ -n "$GHCR_TOKEN" ] && [ "$GHCR_TOKEN" != "None" ] && [ "$GHCR_TOKEN" != "unused" ]; } && break
  [ "$i" -eq 30 ] || sleep 10
done
if [ -z "$GHCR_TOKEN" ] || [ "$GHCR_TOKEN" = "None" ] || [ "$GHCR_TOKEN" = "unused" ]; then
  echo "FATAL: GHCR credential was not readable after the instance-profile propagation window" >&2
  exit 1
fi
unset GHCR_TOKEN
`
    : ''
  const ghcrFetch = ghcrUsername
    ? `
for i in 1 2 3 4 5; do
  GHCR_TOKEN=$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$GHCR_SECRET_ARN" --query SecretString --output text 2>/dev/null || true)
  { [ -n "$GHCR_TOKEN" ] && [ "$GHCR_TOKEN" != "None" ] && [ "$GHCR_TOKEN" != "unused" ]; } && break
  echo "ghcr token fetch attempt $i failed; retrying in $((i*5))s" >&2
  sleep $((i*5))
done
if [ -z "\${GHCR_TOKEN:-}" ] || [ "$GHCR_TOKEN" = "None" ] || [ "$GHCR_TOKEN" = "unused" ]; then
  echo "FATAL: could not fetch ghcr pull token; refusing anonymous pulls" >&2
  exit 1
fi
export GHCR_TOKEN
`
    : ''
  const ghcrDropIn = ghcrUsername
    ? `
Environment=GHCR_SECRET_ARN=${ghcrSecretArn}
Environment=GHCR_USERNAME=${ghcrUsername}`
    : ''

  return `set -euo pipefail
UNIT=/etc/systemd/system/boxlite-runner.service
WRAPPER=/usr/local/bin/boxlite-runner-start.sh
DROPIN_DIR=/etc/systemd/system/boxlite-runner.service.d
DROPIN=$DROPIN_DIR/runtime-secrets.conf
AWS_REGION=${region}
BOXLITE_RUNNER_TOKEN_SECRET_ARN=$(printf '%s' '${runnerTokenArnBase64}' | base64 -d)
GHCR_SECRET_ARN=$(printf '%s' '${ghcrArnBase64}' | base64 -d)
GHCR_USERNAME=$(printf '%s' '${ghcrUsernameBase64}' | base64 -d)

for _ in $(seq 1 60); do
  [ -f "$UNIT" ] && systemctl is-enabled --quiet boxlite-runner 2>/dev/null && break
  sleep 5
done
[ -f "$UNIT" ] || { echo "FATAL: runner unit is not installed" >&2; exit 1; }

# Prove the instance role can resolve every enabled credential before touching
# the live unit. The role association and its IMDS credentials converge
# asynchronously, so retry for at most five minutes. Values stay in shell
# variables and are immediately discarded.
for i in $(seq 1 30); do
  BOXLITE_RUNNER_TOKEN=$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$BOXLITE_RUNNER_TOKEN_SECRET_ARN" --query SecretString --output text 2>/dev/null || true)
  { [ -n "$BOXLITE_RUNNER_TOKEN" ] && [ "$BOXLITE_RUNNER_TOKEN" != "None" ] && [ "$BOXLITE_RUNNER_TOKEN" != "unused" ]; } && break
  [ "$i" -eq 30 ] || sleep 10
done
if [ -z "$BOXLITE_RUNNER_TOKEN" ] || [ "$BOXLITE_RUNNER_TOKEN" = "None" ] || [ "$BOXLITE_RUNNER_TOKEN" = "unused" ]; then
  echo "FATAL: default runner credential was not readable after the instance-profile propagation window" >&2
  exit 1
fi
unset BOXLITE_RUNNER_TOKEN
${ghcrPreflight}
WORK=$(mktemp -d)
cp -a "$UNIT" "$WORK/unit"
[ ! -f "$WRAPPER" ] || cp -a "$WRAPPER" "$WORK/wrapper"
[ ! -f "$DROPIN" ] || cp -a "$DROPIN" "$WORK/dropin"
CACHE_BACKUP_INDEX=$WORK/cloud-cache-backups
: > "$CACHE_BACKUP_INDEX"
COMMITTED=false
rollback() {
  status=$?
  if [ "$COMMITTED" != true ]; then
    cp -a "$WORK/unit" "$UNIT"
    if [ -f "$WORK/wrapper" ]; then cp -a "$WORK/wrapper" "$WRAPPER"; else rm -f "$WRAPPER"; fi
    mkdir -p "$DROPIN_DIR"
    if [ -f "$WORK/dropin" ]; then cp -a "$WORK/dropin" "$DROPIN"; else rm -f "$DROPIN"; fi
    while IFS= read -r -d '' cache_backup && IFS= read -r -d '' cache_file; do
      cp -a "$cache_backup" "$cache_file"
    done < "$CACHE_BACKUP_INDEX"
    systemctl daemon-reload
    systemctl restart boxlite-runner || true
  fi
  rm -rf "$WORK"
  exit "$status"
}
trap rollback EXIT

cat > "$WRAPPER" << 'STARTWRAP'
#!/bin/bash
set -euo pipefail
for i in 1 2 3 4 5; do
  BOXLITE_RUNNER_TOKEN=$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$BOXLITE_RUNNER_TOKEN_SECRET_ARN" --query SecretString --output text 2>/dev/null || true)
  { [ -n "$BOXLITE_RUNNER_TOKEN" ] && [ "$BOXLITE_RUNNER_TOKEN" != "None" ] && [ "$BOXLITE_RUNNER_TOKEN" != "unused" ]; } && break
  echo "runner token fetch attempt $i failed; retrying in $((i*5))s" >&2
  sleep $((i*5))
done
if [ -z "\${BOXLITE_RUNNER_TOKEN:-}" ] || [ "$BOXLITE_RUNNER_TOKEN" = "None" ] || [ "$BOXLITE_RUNNER_TOKEN" = "unused" ]; then
  echo "FATAL: could not fetch the runner token; refusing to start" >&2
  exit 1
fi
export BOXLITE_RUNNER_TOKEN
${ghcrFetch}
exec /usr/local/bin/boxlite-runner
STARTWRAP
chmod 0755 "$WRAPPER"

# Delete both value-bearing shapes this migration can encounter: original
# user-data wrote an unquoted line, while the rollback guard restores a quoted
# line so systemd can safely parse the escaped value.
sed -i -e '/^Environment=BOXLITE_RUNNER_TOKEN=/d' -e '/^Environment="BOXLITE_RUNNER_TOKEN=/d' "$UNIT"

# cloud-init retains decoded copies of historical EC2 user-data on disk. Scrub
# the same exact line from its two known cache shapes without ever reading or
# printing the value. Each touched file is metadata-preserving backed up for the
# transaction rollback, and its original owner/mode are restored after sed.
cache_number=0
for cache_file in /var/lib/cloud/instances/*/user-data.txt /var/lib/cloud/instances/*/scripts/part-001; do
  [ -f "$cache_file" ] || continue
  grep -Eq '^Environment=(")?BOXLITE_RUNNER_TOKEN=' "$cache_file" || continue
  cache_backup=$WORK/cloud-cache-$cache_number
  cp -a "$cache_file" "$cache_backup"
  printf '%s\\0%s\\0' "$cache_backup" "$cache_file" >> "$CACHE_BACKUP_INDEX"
  cache_owner=$(stat -c '%u:%g' "$cache_file")
  cache_mode=$(stat -c '%a' "$cache_file")
  sed -i -e '/^Environment=BOXLITE_RUNNER_TOKEN=/d' -e '/^Environment="BOXLITE_RUNNER_TOKEN=/d' "$cache_file"
  chown "$cache_owner" "$cache_file"
  chmod "$cache_mode" "$cache_file"
  cache_number=$((cache_number + 1))
done
for current_file in "$UNIT" /var/lib/cloud/instances/*/user-data.txt /var/lib/cloud/instances/*/scripts/part-001; do
  [ -f "$current_file" ] || continue
  if grep -Eq '^Environment=(")?BOXLITE_RUNNER_TOKEN=' "$current_file"; then
    echo "FATAL: plaintext default runner credential remains after reconciliation" >&2
    exit 1
  fi
done
mkdir -p "$DROPIN_DIR"
cat > "$DROPIN" << DROPIN
[Service]
UnsetEnvironment=BOXLITE_RUNNER_TOKEN GHCR_TOKEN
Environment=BOXLITE_RUNNER_TOKEN_SECRET_ARN=${runnerTokenSecretArn}${ghcrDropIn}
ExecStart=
ExecStart=/usr/local/bin/boxlite-runner-start.sh
DROPIN

systemctl daemon-reload
systemctl restart boxlite-runner
systemctl is-active --quiet boxlite-runner
COMMITTED=true
echo "default runner runtime-secret drop-in installed"
`
}

export function buildDefaultRunnerLegacyRollback({
  region,
  runnerTokenSecretArn,
  legacyGhcrSecretArn,
  ghcrUsername,
}) {
  if (ghcrUsername && !/^[A-Za-z0-9_.-]+$/.test(ghcrUsername)) {
    throw new Error('ghcrUsername contains unsupported characters')
  }
  const regionBase64 = Buffer.from(region).toString('base64')
  const runnerTokenArnBase64 = Buffer.from(runnerTokenSecretArn).toString('base64')
  const legacyGhcrArnBase64 = Buffer.from(legacyGhcrSecretArn).toString('base64')
  const ghcrUsernameBase64 = Buffer.from(ghcrUsername).toString('base64')
  const legacyExecStart = ghcrUsername
    ? '/usr/local/bin/boxlite-runner-start.sh'
    : '/usr/local/bin/boxlite-runner'
  const legacyGhcrUnitEnvironment = ghcrUsername
    ? `
  printf 'Environment=GHCR_USERNAME=%s\\n' "$GHCR_USERNAME" >> "$RESTORED_UNIT"
  printf 'Environment=GHCR_SECRET_ARN=%s\\n' "$LEGACY_GHCR_SECRET_ARN" >> "$RESTORED_UNIT"`
    : ''
  const legacyGhcrWrapper = ghcrUsername
    ? `
cat > "$WRAPPER" << 'LEGACYWRAP'
#!/bin/bash
set -euo pipefail
for i in 1 2 3 4 5; do
  GHCR_TOKEN=$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$GHCR_SECRET_ARN" --query SecretString --output text 2>/dev/null || true)
  { [ -n "$GHCR_TOKEN" ] && [ "$GHCR_TOKEN" != "None" ] && [ "$GHCR_TOKEN" != "unused" ]; } && break
  echo "ghcr token fetch attempt $i failed; retrying in $((i*5))s" >&2
  sleep $((i*5))
done
if [ -z "\${GHCR_TOKEN:-}" ] || [ "$GHCR_TOKEN" = "None" ] || [ "$GHCR_TOKEN" = "unused" ]; then
  echo "FATAL: could not fetch the legacy ghcr pull token; refusing anonymous pulls" >&2
  exit 1
fi
export GHCR_TOKEN
exec /usr/local/bin/boxlite-runner
LEGACYWRAP
chmod 0755 "$WRAPPER"`
    : 'rm -f "$WRAPPER"'

  return `set -euo pipefail
UNIT=/etc/systemd/system/boxlite-runner.service
WRAPPER=/usr/local/bin/boxlite-runner-start.sh
DROPIN_DIR=/etc/systemd/system/boxlite-runner.service.d
DROPIN=$DROPIN_DIR/runtime-secrets.conf
AWS_REGION=$(printf '%s' '${regionBase64}' | base64 -d)
BOXLITE_RUNNER_TOKEN_SECRET_ARN=$(printf '%s' '${runnerTokenArnBase64}' | base64 -d)
LEGACY_GHCR_SECRET_ARN=$(printf '%s' '${legacyGhcrArnBase64}' | base64 -d)
GHCR_USERNAME=$(printf '%s' '${ghcrUsernameBase64}' | base64 -d)

for _ in $(seq 1 60); do
  [ -f "$UNIT" ] && systemctl is-enabled --quiet boxlite-runner 2>/dev/null && break
  sleep 5
done
[ -f "$UNIT" ] || { echo "FATAL: runner unit is not installed" >&2; exit 1; }

# The historical default profile remains attached while this delete hook runs.
# Resolve the stable value on-host before touching the unit, then restore the
# value-bearing shape expected by the retained pre-migration stack.
for i in $(seq 1 30); do
  BOXLITE_RUNNER_TOKEN=$(aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$BOXLITE_RUNNER_TOKEN_SECRET_ARN" --query SecretString --output text 2>/dev/null || true)
  { [ -n "$BOXLITE_RUNNER_TOKEN" ] && [ "$BOXLITE_RUNNER_TOKEN" != "None" ] && [ "$BOXLITE_RUNNER_TOKEN" != "unused" ]; } && break
  [ "$i" -eq 30 ] || sleep 10
done
if [ -z "\${BOXLITE_RUNNER_TOKEN:-}" ] || [ "$BOXLITE_RUNNER_TOKEN" = "None" ] || [ "$BOXLITE_RUNNER_TOKEN" = "unused" ]; then
  echo "FATAL: default runner credential was not readable for rollback" >&2
  exit 1
fi
if [ -z "\${BOXLITE_RUNNER_TOKEN//[[:space:]]/}" ] || [[ "$BOXLITE_RUNNER_TOKEN" == *$'\\n'* ]] || [[ "$BOXLITE_RUNNER_TOKEN" == *$'\\r'* ]]; then
  echo "FATAL: default runner credential is not safe for the legacy systemd unit" >&2
  exit 1
fi

WORK=$(mktemp -d)
cp -a "$UNIT" "$WORK/unit"
[ ! -f "$WRAPPER" ] || cp -a "$WRAPPER" "$WORK/wrapper"
[ ! -f "$DROPIN" ] || cp -a "$DROPIN" "$WORK/dropin"
COMMITTED=false
rollback() {
  status=$?
  if [ "$COMMITTED" != true ]; then
    cp -a "$WORK/unit" "$UNIT"
    if [ -f "$WORK/wrapper" ]; then cp -a "$WORK/wrapper" "$WRAPPER"; else rm -f "$WRAPPER"; fi
    mkdir -p "$DROPIN_DIR"
    if [ -f "$WORK/dropin" ]; then cp -a "$WORK/dropin" "$DROPIN"; else rm -f "$DROPIN"; fi
    systemctl daemon-reload
    systemctl restart boxlite-runner || true
  fi
  rm -rf "$WORK"
  exit "$status"
}
trap rollback EXIT

UNIT_OWNER=$(stat -c '%u:%g' "$UNIT")
UNIT_MODE=$(stat -c '%a' "$UNIT")
RESTORED_UNIT=$WORK/unit-restored
: > "$RESTORED_UNIT"
TOKEN_ESCAPED=\${BOXLITE_RUNNER_TOKEN//\\\\/\\\\\\\\}
TOKEN_ESCAPED=\${TOKEN_ESCAPED//\\\"/\\\\\\\"}
TOKEN_INSERTED=false
EXEC_START_INSERTED=false
while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    Environment=BOXLITE_RUNNER_TOKEN=*|'Environment="BOXLITE_RUNNER_TOKEN='*|Environment=BOXLITE_RUNNER_TOKEN_SECRET_ARN=*|Environment=GHCR_USERNAME=*|Environment=GHCR_SECRET_ARN=*)
      continue
      ;;
    ExecStart=*)
      if [ "$EXEC_START_INSERTED" = false ]; then
        printf 'ExecStart=%s\\n' '${legacyExecStart}' >> "$RESTORED_UNIT"
        EXEC_START_INSERTED=true
      fi
      continue
      ;;
  esac
  printf '%s\\n' "$line" >> "$RESTORED_UNIT"
  if [[ "$line" == Environment=BOXLITE_API_URL=* ]]; then
    printf 'Environment="BOXLITE_RUNNER_TOKEN=%s"\\n' "$TOKEN_ESCAPED" >> "$RESTORED_UNIT"${legacyGhcrUnitEnvironment}
    TOKEN_INSERTED=true
  fi
done < "$UNIT"
if [ "$TOKEN_INSERTED" != true ] || [ "$EXEC_START_INSERTED" != true ]; then
  echo "FATAL: runner unit does not have the expected legacy insertion points" >&2
  exit 1
fi

cp "$RESTORED_UNIT" "$UNIT"
chown "$UNIT_OWNER" "$UNIT"
chmod "$UNIT_MODE" "$UNIT"
${legacyGhcrWrapper}
rm -f "$DROPIN"
unset BOXLITE_RUNNER_TOKEN TOKEN_ESCAPED

systemctl daemon-reload
systemctl restart boxlite-runner
systemctl is-active --quiet boxlite-runner
COMMITTED=true
echo "default runner restored to the retained legacy credential contract"
`
}

function validateInstanceId(instanceId) {
  return parseEc2InstanceId(instanceId, 'INSTANCE_ID must be an EC2 instance id')
}

function reconcileExtraRunnerGhcr() {
  const instanceId = validateInstanceId(requiredEnvironment('INSTANCE_ID'))
  const region = validateRegion(requiredEnvironment('AWS_REGION'))
  const stage = requiredEnvironment('SST_STAGE')
  const expectedStableName = runtimeSecretName(stage, 'ghcrPullToken')
  const ghcrEnabledValue = requiredEnvironment('GHCR_ENABLED')
  if (ghcrEnabledValue !== 'true' && ghcrEnabledValue !== 'false') {
    throw new Error('GHCR_ENABLED must be true or false')
  }
  const ghcrEnabled = ghcrEnabledValue === 'true'
  const ghcrUsername = process.env.GHCR_USERNAME ?? ''
  const legacyGhcrSecretArn = validateSecretsManagerArn(
    'LEGACY_GHCR_SECRET_ARN',
    requiredEnvironment('LEGACY_GHCR_SECRET_ARN'),
  )
  const ghcrSecretArn = validateSecretsManagerArn('GHCR_SECRET_ARN', requiredEnvironment('GHCR_SECRET_ARN'))
  if (legacyGhcrSecretArn === ghcrSecretArn) {
    throw new Error('legacy and stable GHCR secret ARNs must differ')
  }
  const stableResourceName = ghcrSecretArn.split(':secret:')[1]
  if (stableResourceName !== expectedStableName && !stableResourceName.startsWith(`${expectedStableName}-`)) {
    throw new Error('GHCR_SECRET_ARN does not belong to the selected SST stage')
  }

  verifyRunnerCommandTargets([instanceId], { region, stage })
  const script = buildExtraRunnerGhcrMigration({
    region,
    legacyGhcrSecretArn,
    ghcrSecretArn,
    ghcrEnabled,
    ghcrUsername,
  })
  const commandId = sendCommand(
    instanceId,
    `extra-runner-ghcr-${stage}-${ghcrEnabled ? 'enabled' : 'disabled'}-v1`,
    Buffer.from(script).toString('base64'),
  )
  const invocation = [
    'ssm',
    'get-command-invocation',
    '--region',
    region,
    '--command-id',
    commandId,
    '--instance-id',
    instanceId,
  ]
  const status = waitForTerminalStatus(invocation, instanceId)
  if (status !== 'Success') throw new Error(`${instanceId}: extra-runner GHCR migration finished ${status}`)
}

function reconcileDefaultRunner() {
  const instanceId = validateInstanceId(requiredEnvironment('INSTANCE_ID'))
  const region = validateRegion(requiredEnvironment('AWS_REGION'))
  const stage = requiredEnvironment('SST_STAGE')
  const runnerTokenSecretArn = validateSecretsManagerArn(
    'BOXLITE_RUNNER_TOKEN_SECRET_ARN',
    requiredEnvironment('BOXLITE_RUNNER_TOKEN_SECRET_ARN'),
  )
  const ghcrSecretArn = validateSecretsManagerArn('GHCR_SECRET_ARN', requiredEnvironment('GHCR_SECRET_ARN'))
  const ghcrUsername = process.env.GHCR_USERNAME || ''
  if (ghcrUsername && !/^[A-Za-z0-9_.-]+$/.test(ghcrUsername)) {
    throw new Error('GHCR_USERNAME contains unsupported characters')
  }

  verifyRunnerCommandTargets([instanceId], { region, stage })
  const script = buildDefaultRunnerSecretMigration({ runnerTokenSecretArn, ghcrSecretArn, ghcrUsername, region })
  const commandId = sendCommand(
    instanceId,
    'runtime-secret-drop-in-v1',
    Buffer.from(script).toString('base64'),
  )
  const invocation = [
    'ssm',
    'get-command-invocation',
    '--region',
    region,
    '--command-id',
    commandId,
    '--instance-id',
    instanceId,
  ]
  const status = waitForTerminalStatus(invocation, instanceId)
  if (status !== 'Success') throw new Error(`${instanceId}: runtime-secret migration finished ${status}`)
}

function restoreDefaultRunnerLegacy() {
  const instanceId = validateInstanceId(requiredEnvironment('INSTANCE_ID'))
  const region = validateRegion(requiredEnvironment('AWS_REGION'))
  const stage = requiredEnvironment('SST_STAGE')
  const runnerTokenSecretArn = validateSecretsManagerArn(
    'BOXLITE_RUNNER_TOKEN_SECRET_ARN',
    requiredEnvironment('BOXLITE_RUNNER_TOKEN_SECRET_ARN'),
  )
  const legacyGhcrSecretArn = validateSecretsManagerArn(
    'LEGACY_GHCR_SECRET_ARN',
    requiredEnvironment('LEGACY_GHCR_SECRET_ARN'),
  )
  const ghcrUsername = process.env.GHCR_USERNAME || ''
  if (ghcrUsername && !/^[A-Za-z0-9_.-]+$/.test(ghcrUsername)) {
    throw new Error('GHCR_USERNAME contains unsupported characters')
  }

  verifyRunnerCommandTargets([instanceId], { region, stage })
  const script = buildDefaultRunnerLegacyRollback({
    region,
    runnerTokenSecretArn,
    legacyGhcrSecretArn,
    ghcrUsername,
  })
  const commandId = sendCommand(
    instanceId,
    'runtime-secret-legacy-rollback-v1',
    Buffer.from(script).toString('base64'),
  )
  const invocation = [
    'ssm',
    'get-command-invocation',
    '--region',
    region,
    '--command-id',
    commandId,
    '--instance-id',
    instanceId,
  ]
  const status = waitForTerminalStatus(invocation, instanceId)
  if (status !== 'Success') throw new Error(`${instanceId}: default runner rollback finished ${status}`)
}

function restoreExtraRunnerGhcrLegacy() {
  const instanceId = validateInstanceId(requiredEnvironment('INSTANCE_ID'))
  const region = validateRegion(requiredEnvironment('AWS_REGION'))
  const stage = requiredEnvironment('SST_STAGE')
  const expectedStableName = runtimeSecretName(stage, 'ghcrPullToken')
  const ghcrEnabledValue = requiredEnvironment('GHCR_ENABLED')
  if (ghcrEnabledValue !== 'true' && ghcrEnabledValue !== 'false') {
    throw new Error('GHCR_ENABLED must be true or false')
  }
  const ghcrEnabled = ghcrEnabledValue === 'true'
  const ghcrUsername = process.env.GHCR_USERNAME ?? ''
  const legacyGhcrSecretArn = validateSecretsManagerArn(
    'LEGACY_GHCR_SECRET_ARN',
    requiredEnvironment('LEGACY_GHCR_SECRET_ARN'),
  )
  const stableGhcrSecretArn = validateSecretsManagerArn(
    'GHCR_SECRET_ARN',
    requiredEnvironment('GHCR_SECRET_ARN'),
  )
  if (legacyGhcrSecretArn === stableGhcrSecretArn) {
    throw new Error('legacy and stable GHCR secret ARNs must differ')
  }
  const stableResourceName = stableGhcrSecretArn.split(':secret:')[1]
  if (stableResourceName !== expectedStableName && !stableResourceName.startsWith(`${expectedStableName}-`)) {
    throw new Error('GHCR_SECRET_ARN does not belong to the selected SST stage')
  }

  verifyRunnerCommandTargets([instanceId], { region, stage })
  const script = buildExtraRunnerGhcrLegacyRollback({
    region,
    stableGhcrSecretArn,
    legacyGhcrSecretArn,
    ghcrEnabled,
    ghcrUsername,
  })
  const commandId = sendCommand(
    instanceId,
    `extra-runner-ghcr-legacy-rollback-${stage}-${ghcrEnabled ? 'enabled' : 'disabled'}-v1`,
    Buffer.from(script).toString('base64'),
  )
  const invocation = [
    'ssm',
    'get-command-invocation',
    '--region',
    region,
    '--command-id',
    commandId,
    '--instance-id',
    instanceId,
  ]
  const status = waitForTerminalStatus(invocation, instanceId)
  if (status !== 'Success') throw new Error(`${instanceId}: extra-runner GHCR rollback finished ${status}`)
}

function main(args) {
  const command = args[0]
  const commandArgs = args.slice(1)
  if (command === 'status') return printStatus(commandArgs)
  if (command === 'remove-stale') return removeStale(commandArgs)
  if (command === 'reconcile-default-runner') return reconcileDefaultRunner(commandArgs)
  if (command === 'restore-default-runner-legacy') return restoreDefaultRunnerLegacy(commandArgs)
  if (command === 'reconcile-extra-runner-ghcr') return reconcileExtraRunnerGhcr(commandArgs)
  if (command === 'restore-extra-runner-ghcr-legacy') return restoreExtraRunnerGhcrLegacy(commandArgs)
  throw new Error(
    'expected status, remove-stale, reconcile-default-runner, restore-default-runner-legacy, reconcile-extra-runner-ghcr, or restore-extra-runner-ghcr-legacy',
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(`runtime-secrets: ${error.message}`)
    process.exitCode = 1
  }
}
