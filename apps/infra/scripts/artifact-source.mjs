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
 */

import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { readWorkspaceVersion, resolveReleaseVersion } from './deployment-environment.mjs'

const COMPONENT_SOURCE_KEYS = { api: 'API_ARTIFACT_SOURCE', runner: 'RUNNER_ARTIFACT_SOURCE' }

// Today's behaviour, component by component: the Api has only ever been built from the deployed
// checkout, the Runner has only ever been installed from a published release.
const COMPONENT_DEFAULT_KINDS = { api: 'build', runner: 'release' }

const GLOBAL_SOURCE_KEY = 'BOXLITE_ARTIFACT_SOURCE'
const REF_KEY = 'BOXLITE_ARTIFACT_REF'
const ARTIFACT_KINDS = ['release', 'build']
// Full Git object names only. CI and the local builder key objects by `git rev-parse HEAD`; accepting
// an abbreviation here would address a different S3 key even when it names the same commit.
const COMMIT_REF = /^[0-9a-f]{40}$/

function readKind(key, environment) {
  const configured = environment[key]?.trim()
  if (!configured) return undefined
  if (!ARTIFACT_KINDS.includes(configured)) {
    throw new Error(`${key} must be one of ${ARTIFACT_KINDS.join(', ')} (got '${configured}')`)
  }
  return configured
}

export function readArtifactRef(environment = process.env) {
  const configured = environment[REF_KEY]?.trim()
  if (!configured) return undefined
  const ref = configured.toLowerCase()
  if (!COMMIT_REF.test(ref)) {
    throw new Error(`${REF_KEY} must be a full git commit sha (40 hex characters), got '${configured}'`)
  }
  return ref
}

// Anchored to this module, not the process working directory: run from a nested repository or a
// submodule, a bare `git rev-parse HEAD` answers for that repository and the guard below would
// compare a commit from somewhere else entirely.
const SCRIPT_DIRECTORY = fileURLToPath(new URL('.', import.meta.url))
const git = (args, cwd) =>
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

// A build deploy promises one commit for both components, but only the Runner is addressed by
// ref — SST builds the Api image from whatever this checkout contains. Nothing downstream can
// catch a mismatch: the staged Runner object still verifies, and the post-deploy check only
// compares X.Y.Z. So the checkout has to BE the ref, and that is asserted here.
export function requireCheckoutMatchesArtifactRef(ref, { readHead = requireCleanCheckoutRef } = {}) {
  let head
  try {
    head = readHead()
  } catch (error) {
    throw new Error(`could not read the deployed commit to compare with ${REF_KEY}: ${error.message}`, { cause: error })
  }
  if (head !== ref) {
    throw new Error(
      `${REF_KEY} is ${ref} but this checkout is ${head}; a build deploy installs the Api from the ` +
        'checkout and the Runner from the ref, so they must be the same commit',
    )
  }
}

export function resolveArtifactSource(
  component,
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
  // The ref stays optional here because SST builds the Api image straight from the checkout; only
  // the Runner needs to address an object. resolveRunnerArtifact requires it at that boundary.
  return {
    kind,
    ref: readArtifactRef(environment),
    version: resolveReleaseVersion(readVersion(), {}),
  }
}
