// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Where a Cloudflare provider credential has to be written, and why it is both places.
 *
 * The credential lives in two stores, and which one is read depends on who is deploying:
 *
 *   GitHub Environment secret  — what CI reads. deployment/sst.ts uses an already-set variable as-is,
 *                                and the deploy workflows set these on the job, so this copy wins
 *                                there and the SSM lookup never runs.
 *   SSM SecureString           — what a local deploy falls back to when the variable is unset.
 *
 * Writing only SSM — which is what `--force` did — rotates the copy CI does not read and leaves the
 * live one stale, so a revoked token keeps deploying until somebody notices. So the rule is: whenever
 * bootstrap holds a value, every destination gets it. Ordering still matters for the case where the
 * second write fails, which is why the CI copy goes first; see writeCloudflareCredential.
 *
 * The destinations are injected rather than called directly so this rule is testable without an AWS
 * account or a GitHub token — bootstrap.ts is a script, and none of it was reachable from a test.
 */

export interface CloudflareCredentialWriters {
  writeParameter: (value: string) => void
  writeEnvironmentSecret: (value: string) => void
}

export function writeCloudflareCredential(value: string, writers: CloudflareCredentialWriters) {
  const trimmed = value?.trim()
  // An empty value would store a credential that only fails at deploy time, as an auth error far from
  // its cause. Refuse before either destination is touched, so neither ends up half-written.
  if (!trimmed) throw new Error('a Cloudflare credential cannot be empty')

  // GitHub first, because a failure there has changed nothing at all, and because the alternative
  // ordering puts the dangerous half-write on the CI side: CI deploys unattended, so a stale token
  // there keeps shipping until someone reads a provider auth error, while a stale SSM copy fails in
  // front of the operator who just ran this.
  writers.writeEnvironmentSecret(trimmed)
  try {
    writers.writeParameter(trimmed)
  } catch (cause: any) {
    // The pair is now divergent and decideCredentialRotation cannot see it — both destinations exist,
    // so an ordinary rerun would skip. Say so here, with the flag that repairs it, because this is the
    // only moment anything knows it happened.
    throw new Error(
      `the Cloudflare credential was updated on GitHub but not in SSM, so the two now disagree; ` +
        `rerun with --force to write both (${cause.message})`,
      { cause },
    )
  }
}

/*
 * Whether a rerun has to write this credential again.
 *
 * The first version of this asked only whether the SSM parameter existed, which made a partial write
 * permanent: if the GitHub write failed after SSM succeeded, every later run saw SSM present, skipped,
 * and left CI on the old token until somebody thought to pass --force. The state that most needed
 * repairing was exactly the one the check was blind to.
 *
 * So a skip needs BOTH destinations present. Existence is all that can be compared, because the GitHub
 * API never returns a secret's value back.
 *
 * That catches a torn FIRST write, where one destination is still absent. It cannot catch a torn
 * ROTATION: if both already held the old value and only one took the new one, both still exist and a
 * rerun skips, leaving the two disagreeing indefinitely. Detecting that would need a readable
 * fingerprint of the secret kept beside it — a second GitHub variable per credential, which is more
 * contract surface than the case warrants. Instead writeCloudflareCredential writes the CI copy first,
 * so the failure that survives is the one an operator sees immediately, and it raises an error naming
 * --force rather than letting the divergence pass silently. Residual risk if that error is ignored, or
 * if the process is killed between the two writes: --force is the repair either way.
 */
export function decideCredentialRotation({ parameterExists, environmentSecretExists, force }: any) {
  if (force) return 'write'
  return parameterExists && environmentSecretExists ? 'skip' : 'write'
}
