// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Where a deployed component's artifact comes from.
 *
 * The Api and the Runner used to sit on opposite corners of the same choice: the Api could only
 * be built from the deployed checkout, the Runner could only be installed from a published
 * GitHub Release, and neither could do what the other did. So an unreleased Runner change could
 * not be tested at all, and the Api artifact that passed a stage was never the one promoted out
 * of it. This resolver is the single place that answers "release or build?", for both:
 *
 *   release → an artifact published for a stable X.Y.Z (the workspace version, or VERSION)
 *   build   → an artifact produced from the deployed commit
 *
 * The default is each component's existing behaviour rather than something derived from the
 * stage. A stage rule would silently change which binary a plain `npm run deploy --stage dev`
 * installs onto a state-holding Runner, and would demand a staged build artifact from anyone who
 * only meant to redeploy the Api. Both new corners are opt-in, and one variable moves both.
 *
 * Env:
 *   BOXLITE_ARTIFACT_SOURCE   release|build, for both components
 *   API_ARTIFACT_SOURCE       release|build, Api only — wins over the global
 *   RUNNER_ARTIFACT_SOURCE    release|build, Runner only — wins over the global
 *   BOXLITE_ARTIFACT_REF      the commit build-mode artifacts were produced from
 *   API_ARTIFACT_REF          that commit, Api only — wins over the global
 *   RUNNER_ARTIFACT_REF       that commit, Runner only — wins over the global
 *
 * A ref is per-component for the same reason a source is: publishing is not atomic across the
 * two. CI publishes both for one commit and sets the global key; `npm run runner:build-artifact`
 * stages only a Runner, so it sets the Runner key and leaves the Api building from the checkout.
 * A build with no ref at all is a plain local deploy with nothing published for either.
 */

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { readWorkspaceVersion, resolveReleaseVersion } from '../deployment/environment.js'

type ArtifactComponent = 'api' | 'runner'
const COMPONENT_SOURCE_KEYS: Record<ArtifactComponent, string> = { api: 'API_ARTIFACT_SOURCE', runner: 'RUNNER_ARTIFACT_SOURCE' }

// The default each component started with: the Api from the deployed commit, the Runner from a
// published release. Both are still what an unconfigured deploy gets.
const COMPONENT_DEFAULT_KINDS = { api: 'build', runner: 'release' }

const GLOBAL_SOURCE_KEY = 'BOXLITE_ARTIFACT_SOURCE'
const REF_KEY = 'BOXLITE_ARTIFACT_REF'
// The same component-wins-over-global rule the source keys follow. It exists because the two
// components' build artifacts are produced by different things: CI publishes both for one commit
// and sets the global key, while `npm run runner:build-artifact` stages only a Runner and has to
// say so — otherwise the Api would resolve a commit image that local build never pushed.
const COMPONENT_REF_KEYS = { api: 'API_ARTIFACT_REF', runner: 'RUNNER_ARTIFACT_REF' }
const ARTIFACT_KINDS = ['release', 'build']
// Full Git object names only. CI and the local builder key objects by `git rev-parse HEAD`; accepting
// an abbreviation here would address a different S3 key even when it names the same commit.
const COMMIT_REF = /^[0-9a-f]{40}$/

function readKind(key: any, environment: any) {
  const configured = environment[key]?.trim()
  if (!configured) return undefined
  if (!ARTIFACT_KINDS.includes(configured)) {
    throw new Error(`${key} must be one of ${ARTIFACT_KINDS.join(', ')} (got '${configured}')`)
  }
  return configured
}

// The ref and the key it came from. Callers report the key, so an operator edits the variable
// that is actually set rather than the global one they may never have touched.
function artifactRefEntry(environment: NodeJS.ProcessEnv, component: ArtifactComponent | undefined) {
  const componentKey = component ? COMPONENT_REF_KEYS[component] : undefined
  const key = componentKey && environment[componentKey]?.trim() ? componentKey : REF_KEY
  const configured = environment[key]?.trim()
  if (!configured) return { key, ref: undefined }
  const ref = configured.toLowerCase()
  if (!COMMIT_REF.test(ref)) {
    throw new Error(`${key} must be a full git commit sha (40 hex characters), got '${configured}'`)
  }
  return { key, ref }
}


// Anchored to this module, not the process working directory: run from a nested repository or a
// submodule, a bare `git rev-parse HEAD` answers for that repository and the guard below would
// compare a commit from somewhere else entirely.
const SCRIPT_DIRECTORY = fileURLToPath(new URL('.', import.meta.url))
const git = (args: any, cwd: any) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  }).trim()

export function requireCleanCheckoutRef({ run = git } = {}) {
  const root = run(['rev-parse', '--show-toplevel'], SCRIPT_DIRECTORY)
  // HEAD equality alone does not prove the Api is built from `ref`: an uncommitted edit ships in
  // the image while the commit id still matches. The local builder refuses a dirty tree before
  // staging for exactly this reason, and this is the deploy-side half of that rule.
  if (run(['status', '--porcelain', '--untracked-files=all'], root)) {
    throw new Error('the checkout has uncommitted changes, so the Api image would not be the staged commit')
  }
  return run(['rev-parse', 'HEAD'], root)
}

// A build deploy promises one commit for the whole stack, but only some of it is addressed by
// ref: the Proxy and the OtelCollector are always built from whatever this checkout contains, and
// which of the Api and the Runner are ref-addressed depends on which keys are set. Nothing
// downstream can catch a mismatch — the staged Runner object still verifies, and the post-deploy
// check only compares X.Y.Z. So every ref this deploy resolved has to BE the checkout.
//
// Takes the sources rather than one ref because the caller must not have to decide which
// component's ref stands in for the rest. Gating on a single component's is what let a
// Runner-only local deploy install a binary from one commit beside services built from another.
export function requireCheckoutMatchesArtifactRefs(sources: any, { readHead = requireCleanCheckoutRef } = {}) {
  const addressed = sources.filter((source: any) => source?.ref)
  if (addressed.length === 0) return

  let head
  try {
    head = readHead()
  } catch (error: any) {
    // No key named here: the refs being compared may have come from any of the three, and this
    // path does not yet know which one will disagree.
    throw new Error(`could not read the deployed commit to compare the build refs against: ${error.message}`, {
      cause: error,
    })
  }
  for (const { ref, refKey = REF_KEY } of addressed) {
    if (head === ref) continue
    throw new Error(
      `${refKey} is ${ref} but this checkout is ${head}; a build deploy installs ref-addressed ` +
        'artifacts and builds the rest of the stack from the checkout, so they must be the same commit',
    )
  }
}

export function resolveArtifactSource(
  component: ArtifactComponent,
  environment = process.env,
  { readVersion = readWorkspaceVersion } = {},
) {
  const componentKey = COMPONENT_SOURCE_KEYS[component]
  if (!componentKey) {
    const known = Object.keys(COMPONENT_SOURCE_KEYS).join(' or ')
    throw new Error(`unknown deployable component '${component}' (expected ${known})`)
  }

  const kind =
    readKind(componentKey, environment) ??
    readKind(GLOBAL_SOURCE_KEY, environment) ??
    COMPONENT_DEFAULT_KINDS[component]

  if (kind === 'release') return { kind, version: resolveReleaseVersion(readVersion(), environment) }

  // Build identity comes from the checkout, never VERSION: VERSION selects a published artifact,
  // while a commit build has to carry the Cargo version that commit actually compiled. Including
  // it in the S3 filename makes a cross-version ref fail during preflight instead of installing a
  // valid binary whose health identity can never equal the deployer's reconstructed target.
  //
  // The ref stays optional here because a local `npm run deploy` has nothing published to address
  // and falls back to building the Api from the checkout. Each component requires it at its own
  // boundary instead: resolveRunnerArtifact always, verifyApiImage only once a ref is present.
  const { key: refKey, ref } = artifactRefEntry(environment, component)
  return {
    kind,
    ref,
    refKey,
    version: resolveReleaseVersion(readVersion(), {}),
  }
}
