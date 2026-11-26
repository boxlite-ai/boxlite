// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0-only

import { execFileSync } from 'node:child_process'
import type { MstageConfig } from 'mstage/config'
import type { Scope } from 'mstage/scope'

export const QUALIFIED_RELEASE_WORKFLOW =
  'Use the protected mdeploy-all workflow on main for complete outbound stage writes'
const REPOSITORY = 'boxlite-ai/boxlite'
const MAIN = 'refs/heads/main'
const SHA = /^[0-9a-f]{40}$/

export function isCompleteOutboundStage(config: MstageConfig, scope: Scope): boolean {
  const setting = config.stages[scope.stage ?? '']?.deploy.completeOutboundRelease
  if (setting === undefined || setting === false) return false
  if (setting !== true) throw new Error('deploy.completeOutboundRelease must be true or false')
  if (scope.stage === 'dev') throw new Error('Global complete outbound activation excludes dev')
  if (scope.home !== 'gcp' || !scope.protect || !scope.project) {
    throw new Error('Complete outbound requires a protected GCP stage')
  }
  if (scope.app !== config.app) throw new Error('The complete outbound stage app must match its deployment declaration')
  if (
    Object.entries(config.stages).some(
      ([stage, declaration]) => stage !== scope.stage && declaration.project === scope.project,
    )
  ) {
    throw new Error('Complete outbound requires a GCP project dedicated to its stage')
  }
  return true
}

export function assertQualifiedApply(environment: NodeJS.ProcessEnv, cwd: string) {
  const sha = environment.BOXLITE_RELEASE_SHA ?? ''
  const dispatchCommit = environment.GITHUB_SHA ?? ''
  if (
    environment.GITHUB_ACTIONS !== 'true' ||
    environment.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    environment.GITHUB_REPOSITORY !== REPOSITORY ||
    environment.GITHUB_REF !== MAIN ||
    environment.GITHUB_REF_PROTECTED !== 'true' ||
    environment.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/.github/workflows/mdeploy-all.yml@${MAIN}` ||
    environment.BOXLITE_RELEASE_COMPONENTS !== 'api+runner' ||
    !SHA.test(sha) ||
    !SHA.test(dispatchCommit)
  ) {
    throw new Error(QUALIFIED_RELEASE_WORKFLOW)
  }
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, dispatchCommit], { cwd, stdio: 'ignore' })
  } catch {
    throw new Error('Selected deployment commit must be part of the protected workflow ref')
  }
}
