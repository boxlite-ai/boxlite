// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * The stage's configuration, read back out of the SST secret store.
 *
 * `npm run bootstrap` loads the operator's .env into that store (bootstrap/bootstrap.ts's
 * ensureStageConfig), and this is the other half: the deploy wrapper hydrates process.env from it
 * before spawning sst, so stack/*.ts keeps reading plain `process.env` / `envOr()` values. That
 * matters — a config key promoted to `sst.Secret` would arrive as an Output<string> and break every
 * `envOr('JAEGER_PUBLIC','false') === 'true'` comparison and `new URL(...)` in the stack.
 *
 * Two things are deliberately NOT here. The Cloudflare provider credentials cannot be, because
 * reading this store initializes that provider — see the note in deployment/sst.ts. And AWS_REGION
 * cannot be, because the wrapper resolves the region before it reads the store.
 *
 * It replaces the GitHub Environment secret DEPLOY_ENV, which the deploy workflow used to
 * materialize as apps/infra/.env for the length of a job. That put stage config in a second control
 * plane: changing what gets deployed needed no AWS access, and offboarding meant revoking both.
 * Reading this store needs the same AWS credentials a deploy already needs.
 *
 * The store is NOT the authority on everything in it. Two rules narrow what may reach process.env,
 * because `sst secret set` is a command any deployer can run against any name:
 *
 *   - only keys the manifest names (STAGE_CONFIG_MANIFEST_KEY) are eligible, so a value written by
 *     hand — or left behind by a key since deleted from .env — is inert rather than live; and
 *   - the key must be one the deploy demonstrably reads (isStorableStageConfigKey, derived from source
 *     in deployment/storable-keys.ts) — so an unknown name is refused without anyone naming it; and
 *   - isLocalOnlyDeploymentKey still drops the keys that ARE read but must stay on this machine,
 *     AWS_PROFILE among them.
 *
 * Every value here is a secret. Nothing in this module logs one, and the caller gets key names only.
 */

import { createHash } from 'node:crypto'

import { isStorableStageConfigKey } from './storable-keys.js'
import { isLocalOnlyDeploymentKey } from './validate-environment.js'

/*
 * The one entry in the store that is not configuration: a comma-separated list of the key names
 * bootstrap owns.
 *
 * `sst secret load` merges rather than replacing, so a key removed from .env would otherwise linger
 * in the store and keep being applied. Scoping hydration to this list makes that stale entry inert
 * the moment bootstrap reruns, with no prune step — which could not be done safely anyway, since the
 * same store legitimately holds OIDC_CLIENT_ID and the other hand-set `sst.Secret` values that .env
 * never contains.
 */
export const STAGE_CONFIG_MANIFEST_KEY = 'BOXLITE_STAGE_CONFIG'

/*
 * A digest of the values the manifest names, written in the same `sst secret load` as the values.
 *
 * `secret load` is not atomic — it is a read-modify-write of one JSON document per invocation, and an
 * interrupted one can leave some keys at their new values and some at their old. The manifest cannot
 * detect that: every name it lists is still present, just not all from the same generation. Nothing
 * downstream would notice, and the stage would deploy a configuration that never existed as a whole.
 *
 * So the digest is computed over the values, and hydration recomputes it. A mixture fails to match.
 */
export const STAGE_CONFIG_DIGEST_KEY = 'BOXLITE_STAGE_CONFIG_DIGEST'

/*
 * The entries in the store that describe the configuration rather than being part of it.
 *
 * One list, because every consumer has to skip all of them and each does it for its own reason:
 * hydration must not export them as configuration, and `npm run secrets` must not report them as
 * secrets. Adding the digest as a second such key broke the second of those, which had matched the
 * manifest by name alone — so the set is named here and both read it.
 */
export const STAGE_CONFIG_BOOKKEEPING_KEYS: readonly string[] = [STAGE_CONFIG_MANIFEST_KEY, STAGE_CONFIG_DIGEST_KEY]

export function isStageConfigBookkeepingKey(key: string) {
  return STAGE_CONFIG_BOOKKEEPING_KEYS.includes(key)
}

/*
 * The digest of a set of stored values, over the manifest's keys in sorted order.
 *
 * Deliberately not a hash of the whole store: the store also holds hand-set `sst.Secret` values whose
 * rotation has nothing to do with this configuration, and including them would make every unrelated
 * `secret set` look like a torn load.
 */
export function stageConfigDigest(keys: readonly string[], values: Record<string, string | undefined>) {
  const hash = createHash('sha256')
  for (const key of [...keys].sort()) {
    // Length-prefixed, so `A=1,B=2` and `A=1B=2` cannot collide.
    const value = values[key] ?? ''
    hash.update(`${key.length}:${key}=${value.length}:${value}\n`)
  }
  return hash.digest('hex')
}

const SECRET_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/
const FALLBACK_SECTION = 'fallback'

/*
 * `sst secret list` prints the fallback values under a `# fallback` header and the stage's own under
 * a `# <app>/<stage>` header. Track the header rather than relying on the stage section coming last:
 * a key set in both places must resolve to the stage's value because that is the one `sst deploy`
 * would use, and "whichever line came later" is an ordering detail of sst's output, not a contract.
 *
 * Anything that is neither a header nor a KEY=value assignment is ignored, which is what makes the
 * empty store ("No secrets found") a normal answer instead of a parse error.
 */
export function parseSecretList(stdout: any, { app, stage }: any) {
  const stageSection = `${app}/${stage}`
  const fallback: Record<string, string> = {}
  const stageValues: Record<string, string> = {}
  let section

  for (const rawLine of String(stdout ?? '').split('\n')) {
    // Split on \n and strip only a trailing \r: sst prints `key + "=" + value` with nothing added,
    // so anything else on the line is part of the value. Trimming the whole line would silently
    // delete a stored value's leading or trailing spaces, which serializeStageConfig goes out of its
    // way to preserve.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.trim() === '') continue
    if (line.trimStart().startsWith('#')) {
      section = line.trim().slice(1).trim()
      continue
    }
    const match = SECRET_ASSIGNMENT.exec(line)
    if (!match) continue
    const [, key, value] = match
    /*
     * The bookkeeping keys are never taken from the fallback section.
     *
     * A fallback belongs to the app, so `sst secret set --fallback BOXLITE_STAGE_CONFIG …` would give
     * every stage a manifest — and with it a digest that matches, since both would come from the same
     * place. A stage nobody has bootstrapped would then pass the manifest and digest checks and deploy
     * another source's configuration, which is precisely the case those checks exist to stop.
     *
     * Ordinary values still fall back, which is what fallbacks are for: the value is shared on purpose
     * and the stage's own manifest has to name it before anything is hydrated.
     */
    if (section === stageSection) stageValues[key] = value
    else if (section === FALLBACK_SECTION && !isStageConfigBookkeepingKey(key)) fallback[key] = value
  }

  return { ...fallback, ...stageValues }
}

export function parseStageConfigManifest(rawManifest: any) {
  return String(rawManifest ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function serializeStageConfigManifest(keys: any) {
  return [...new Set(keys)].sort().join(',')
}

/*
 * Which stored values may reach process.env, and which must not.
 *
 * A variable already present in the environment always wins. That is what keeps the deploy workflow
 * in control of the values it sets itself — BOXLITE_ARTIFACT_SOURCE, BOXLITE_ARTIFACT_REF, STAGE,
 * DEPLOY_EXCLUDE — and it is the same rule the Cloudflare credentials were read under before this
 * store existed ("already provided — don't touch"). It also gives an operator a one-variable escape
 * hatch when a stored value is wrong.
 *
 * Returns key names only; the values go into the caller's environment, never into a log.
 */
export function hydrateStageConfig({ stored, environment = process.env }: any) {
  const manifest = new Set(parseStageConfigManifest(stored?.[STAGE_CONFIG_MANIFEST_KEY]))
  // Empty when the store holds no digest at all, which is a mismatch like any other: bootstrap writes
  // it in the same `secret load` as the manifest, so a manifest without one means that load tore.
  const recordedDigest = stored?.[STAGE_CONFIG_DIGEST_KEY]?.trim() ?? ''
  const actualDigest = stageConfigDigest([...manifest], stored ?? {})
  const apply: Record<string, string> = {}
  const alreadySet = []
  const unlisted = []
  // Named by the manifest but absent from the store: bootstrap writes both together, so a gap means
  // the write did not finish or something removed a value afterwards.
  const missing = [...manifest]
    .filter((key) => isStorableStageConfigKey(key) && !isLocalOnlyDeploymentKey(key) && stored?.[key] === undefined)
    .sort()

  for (const key of Object.keys(stored ?? {}).sort()) {
    if (isStageConfigBookkeepingKey(key)) continue
    // Checked before the manifest so a forbidden key is reported as forbidden even if something
    // managed to name it in the manifest too.
    // Allowlist first: a key the deploy never reads is refused whether or not anyone thought to name
    // it. The denylist behind it catches the keys that ARE read but must not be stored — AWS_PROFILE.
    if (!isStorableStageConfigKey(key) || isLocalOnlyDeploymentKey(key)) {
      unlisted.push(key)
      continue
    }
    if (!manifest.has(key)) {
      unlisted.push(key)
      continue
    }
    if (environment[key] !== undefined) {
      alreadySet.push(key)
      continue
    }
    apply[key] = stored[key]
  }

  return { apply, alreadySet, unlisted, missing, recordedDigest, actualDigest }
}

/*
 * The stage's store, behind one read.
 *
 * `runSst` is injected because the two callers must reach sst differently: the deploy wrapper owns
 * the resolved binary and has to call it directly (routing back through the wrapper would recurse),
 * while bootstrap goes through the wrapper like every other sst call it makes. Injecting it also
 * means the parsing and precedence rules above are testable without sst.
 */
export class StageConfigStore {
  #runSst
  #app
  #stage

  constructor({ runSst, app, stage }: any) {
    if (typeof runSst !== 'function') throw new Error('StageConfigStore requires a runSst function')
    if (!app || !stage) throw new Error('StageConfigStore requires an app and a stage')
    this.#runSst = runSst
    this.#app = app
    this.#stage = stage
  }

  read() {
    return parseSecretList(this.#runSst(['secret', 'list', '--stage', this.#stage]), {
      app: this.#app,
      stage: this.#stage,
    })
  }
}
