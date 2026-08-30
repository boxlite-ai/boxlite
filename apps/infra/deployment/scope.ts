// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Which components a deploy covers, and which partial shapes are allowed to say so.
 *
 * A full deploy is still the default and still what an unqualified `npm run deploy` gets. The two
 * partial shapes below exist so a change to one leg does not have to rebuild and reconcile the
 * other — a Runner build is the long pole, and an Api-only change should not pay for it.
 *
 * Only `--exclude` expresses that, never `--target`. PR #1095 took the dev stack down with
 * `--target Api`: Pulumi cannot migrate a provider while untargeted resources still reference the
 * old registration, and SST stopped on StorageBucket before any application resource deployed.
 * `--exclude` was the recovery, because it leaves shared and provider resources in the plan and
 * omits one leaf. That distinction is the whole reason this module is an allowlist rather than a
 * parser: an operator may pick a reviewed shape, not compose a new one.
 *
 * The residual risk from README.md ("Deploy an existing stack") is unchanged and conditional — an
 * omitted resource still referencing an old provider is a problem whenever the provider version
 * moves. Preview first; the workflow's `apply` input defaults to false for this reason.
 */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The components with a published artifact, and so the only ones a scope can drop. The Proxy and
// the OtelCollector build from the checkout on every path and stay in every plan.
const DEPLOY_COMPONENTS = ['api', 'runner']
// The SST resource whose exclusion drops each component's leg.
const COMPONENT_EXCLUSIONS = { Api: 'api', Runner: 'runner' }
type ComponentExclusion = keyof typeof COMPONENT_EXCLUSIONS
const isComponentExclusion = (value: string | undefined): value is ComponentExclusion =>
  value !== undefined && Object.prototype.hasOwnProperty.call(COMPONENT_EXCLUSIONS, value)

const PARTIAL_DEPLOY_SELECTOR = /^--(?:target|exclude)(?:=|$)/
const RUNNER_POLICY_ROOT = resolve(fileURLToPath(new URL('../policies/runner', import.meta.url)))
const RUNNER_POLICY_SUBCOMMANDS = new Set(['diff', 'deploy'])

export function requireSstSubcommandFirst(args: any) {
  if (!args[0] || args[0].startsWith('-')) {
    throw new Error('the SST subcommand must be the first argument so deployment safety checks cannot be bypassed')
  }
  if (args[0] === 'dev') {
    throw new Error('sst dev is disabled for this stateful stack; use a fresh guarded diff and deploy instead')
  }
  if (RUNNER_POLICY_SUBCOMMANDS.has(args[0]) && args.includes('--')) {
    throw new Error('the -- argument delimiter is disabled for guarded SST diff and deploy commands')
  }
}

// A flag's value whether it was spelled `--exclude Runner` or `--exclude=Runner`, so a scope
// cannot be smuggled past the allowlist by choosing the other spelling.
function readSelectors(args: any) {
  const selectors = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!PARTIAL_DEPLOY_SELECTOR.test(argument)) continue
    const separator = argument.indexOf('=')
    const inline = separator === -1 ? undefined : argument.slice(separator + 1)
    const flag = separator === -1 ? argument : argument.slice(0, separator)
    let value = inline
    if (inline === undefined) {
      const next = args[index + 1]
      // A following flag is a missing value, not the value itself, so `--exclude --stage` fails
      // here instead of excluding a component named --stage.
      value = next && !next.startsWith('-') ? next : undefined
      if (value !== undefined) index += 1
    }
    selectors.push({ flag: flag.slice(2), value, raw: argument })
  }
  return selectors
}

const FULL_SCOPE = Object.freeze({ components: Object.freeze([...DEPLOY_COMPONENTS]), excluded: Object.freeze([]) })

/*
 * The components this invocation deploys.
 *
 * Read by the deploy wrapper's preflight as well as by the guard: a component that is not being
 * deployed must not be verified, or an Api-only deploy would still demand a published Runner
 * artifact for a commit whose Runner was deliberately never built. One resolver answers both so
 * the plan and the preflight cannot disagree about what is in scope.
 */
export function resolveDeployScope(args: any) {
  const selectors = readSelectors(args)

  // Only `deploy` mutates, so only `deploy` is held to the allowlist — a targeted `diff` stays
  // legal for read-only inspection.
  if (args[0] === 'deploy') {
    if (selectors.length > 1) {
      throw new Error(
        `a deploy carries at most one scope selector (got ${selectors.map((s) => s.raw).join(', ')}); ` +
          'a composed scope is not one of the reviewed shapes',
      )
    }
    for (const selector of selectors) {
      if (selector.flag === 'target') {
        throw new Error(
          `--target is disabled for deploys (${selector.raw}); it omits the shared and provider resources a ` +
            'targeted update still depends on, which is how PR #1095 stalled the stack mid-provider-migration. ' +
            `Use --exclude ${Object.keys(COMPONENT_EXCLUSIONS).join(' or --exclude ')} instead`,
        )
      }
      if (!isComponentExclusion(selector.value)) {
        throw new Error(
          `--exclude ${selector.value || '(no value)'} is not a reviewed deploy scope; ` +
            `exclude exactly one of ${Object.keys(COMPONENT_EXCLUSIONS).join(', ')}`,
        )
      }
    }
  }

  // Derived from the selector, never from the subcommand — `diff` has to build the same resource
  // graph the `deploy` behind it will build. Scoping this on `args[0] === 'deploy'` made the
  // preview declare UpgradeRunnerBinary-* and plan an update where the apply, having undeclared
  // it, planned a delete: the plan an operator approved was not the plan that ran.
  //
  // `--target` never narrows it. It filters which declared resources are acted on; it does not
  // remove declarations, and Pulumi reads a missing declaration as a delete.
  const excluded = selectors
    .filter((selector) => selector.flag === 'exclude')
    .map((selector) => (isComponentExclusion(selector.value) ? COMPONENT_EXCLUSIONS[selector.value] : undefined))
    .filter(Boolean)
  if (excluded.length === 0) return FULL_SCOPE

  return Object.freeze({
    components: Object.freeze(DEPLOY_COMPONENTS.filter((candidate) => !excluded.includes(candidate))),
    excluded: Object.freeze([...new Set(excluded)]),
  })
}

// How the resolved scope reaches sst.config.ts. The config cannot see argv — SST parses it — so
// the wrapper exports what it already resolved and the config reads it back. One resolver still
// owns the answer; this is only its transport.
export const DEPLOY_SCOPE_KEY = 'BOXLITE_DEPLOY_SCOPE'

export function exportDeployScope(scope: any, environment = process.env) {
  environment[DEPLOY_SCOPE_KEY] = scope.components.join(',')
}

/*
 * The scope sst.config.ts must build for.
 *
 * An ABSENT key means the full stack — a bare `sst` invocation, or a local `npm run deploy`.
 * A key that is present but empty means the empty scope, which `diff --exclude Api --exclude
 * Runner` legitimately produces; keyed on presence rather than truthiness so that case does not
 * round-trip back to the full stack and preview a graph the operator did not ask for.
 *
 * A value that is set but unreadable throws rather than defaulting: silently widening it would
 * declare resources an excluded deploy is not allowed to touch, and silently narrowing it would
 * drop resources from a full deploy — Pulumi reads "not declared" as "delete".
 */
export function readDeployScope(environment = process.env) {
  if (!(DEPLOY_SCOPE_KEY in environment) || environment[DEPLOY_SCOPE_KEY] === undefined) {
    return [...DEPLOY_COMPONENTS]
  }
  const configured = environment[DEPLOY_SCOPE_KEY].trim()
  if (!configured) return []

  const components = configured.split(',').map((entry) => entry.trim())
  const unknown = components.filter((component) => !DEPLOY_COMPONENTS.includes(component))
  if (unknown.length > 0 || new Set(components).size !== components.length) {
    throw new Error(
      `${DEPLOY_SCOPE_KEY} must be a unique comma-separated subset of ${DEPLOY_COMPONENTS.join(', ')} ` +
        `(got '${configured}')`,
    )
  }
  return components
}

export function withRequiredRunnerPolicy(args: any, workingDirectory = process.cwd()) {
  if (!RUNNER_POLICY_SUBCOMMANDS.has(args[0])) return [...args]

  const policyArguments = []
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--policy') {
      const value = args[index + 1]
      const hasValue = value !== undefined && !value.startsWith('--')
      policyArguments.push({ index, valueIndex: hasValue ? index + 1 : undefined, value: hasValue ? value : undefined })
      if (hasValue) index += 1
    } else if (argument.startsWith('--policy=')) {
      policyArguments.push({ index, value: argument.slice('--policy='.length) })
    }
  }

  if (policyArguments.length > 1) {
    throw new Error('the Runner policy must be specified exactly once')
  }
  if (policyArguments.length === 0) {
    return [...args, '--policy', RUNNER_POLICY_ROOT]
  }

  const [policyArgument] = policyArguments
  if (!policyArgument.value || resolve(workingDirectory, policyArgument.value) !== RUNNER_POLICY_ROOT) {
    throw new Error(`the Runner policy path must be ${RUNNER_POLICY_ROOT}`)
  }

  const normalizedArgs = [...args]
  if (policyArgument.valueIndex === undefined) {
    normalizedArgs[policyArgument.index] = `--policy=${RUNNER_POLICY_ROOT}`
  } else {
    normalizedArgs[policyArgument.valueIndex] = RUNNER_POLICY_ROOT
  }
  return normalizedArgs
}
