/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { createHash } from 'node:crypto'
import { GitHubInstallation } from '../github-app'
import { decodeRepository, JobNotice } from '../jobs'
import { RunnerScope } from '../runners'
import { StateCorrupt } from '../state/database'

export interface ExecutionScope {
  binding: string
  generation: number
  organization: string
  actor: string
  installation: { id: number; account: GitHubInstallation['account'] }
  runners: RunnerScope
}
export type ResourcePhase = 'none' | 'requested' | 'known' | 'absent'
export type EffectKind = 'box-create' | 'box-stop' | 'box-remove' | 'runner-register' | 'runner-remove' | 'jit-deliver'
export interface Allocation {
  scope: string
  name: string
  job: JobNotice
  createdAt: number
  box: { phase: ResourcePhase; id: string | null }
  runner: { phase: ResourcePhase; id: number | null }
  delivery: 'none' | 'requested' | 'done'
  closing: boolean
  effect: { id: string; kind: EffectKind } | null
}
export const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
export const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const subject = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,127}$/.test(value)
const login = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(value)
export const scopeKey = (scope: ExecutionScope): string =>
  'scope/' + createHash('sha256').update(JSON.stringify(scope)).digest('hex')

/** Canonical non-secret metadata, pinned to the original host and GitHub account. */
export function decodeScope(value: unknown): ExecutionScope {
  if (
    !object(value) ||
    !subject(value.binding) ||
    !positive(value.generation) ||
    !subject(value.organization) ||
    typeof value.actor !== 'string' ||
    value.actor.length === 0 ||
    !object(value.installation) ||
    !Number.isSafeInteger(value.installation.id) ||
    (value.installation.id as number) < 0 ||
    !object(value.installation.account) ||
    !positive(value.installation.account.id) ||
    !login(value.installation.account.login) ||
    !['User', 'Organization'].includes(value.installation.account.type as string) ||
    !object(value.runners) ||
    typeof value.runners.allowPublic !== 'boolean' ||
    typeof value.runners.allowPrivate !== 'boolean'
  )
    throw new StateCorrupt()
  const account = {
    id: value.installation.account.id,
    login: value.installation.account.login.toLowerCase(),
    type: value.installation.account.type as 'User' | 'Organization',
  }
  let runners: RunnerScope
  if (value.runners.kind === 'repository') {
    const repo = decodeRepository(value.runners.repository)
    if (repo.owner.id !== account.id || repo.owner.login.toLowerCase() !== account.login) throw new StateCorrupt()
    runners = {
      kind: 'repository',
      repository: { ...repo, name: repo.name.toLowerCase(), owner: { ...repo.owner, login: account.login } },
      allowPublic: value.runners.allowPublic,
      allowPrivate: value.runners.allowPrivate,
    }
  } else {
    if (
      value.runners.kind !== 'organization' ||
      account.type !== 'Organization' ||
      value.installation.id === 0 ||
      !object(value.runners.account) ||
      value.runners.account.id !== account.id ||
      typeof value.runners.account.login !== 'string' ||
      value.runners.account.login.toLowerCase() !== account.login ||
      !positive(value.runners.group) ||
      !Array.isArray(value.runners.repositories) ||
      !value.runners.repositories.length ||
      value.runners.repositories.length > 100_000 ||
      !value.runners.repositories.every(positive) ||
      new Set(value.runners.repositories).size !== value.runners.repositories.length
    )
      throw new StateCorrupt()
    runners = {
      kind: 'organization',
      account: { id: account.id, login: account.login },
      group: value.runners.group,
      repositories: [...value.runners.repositories].sort((a, b) => a - b),
      allowPublic: value.runners.allowPublic,
      allowPrivate: value.runners.allowPrivate,
    }
  }
  return {
    binding: value.binding,
    generation: value.generation,
    organization: value.organization,
    actor: value.actor,
    installation: { id: value.installation.id as number, account },
    runners,
  }
}
export function decodeAllocation(value: unknown): Allocation {
  if (
    !object(value) ||
    typeof value.scope !== 'string' ||
    !/^scope\/[a-f0-9]{64}$/.test(value.scope) ||
    typeof value.name !== 'string' ||
    !/^ci-jit-[a-f0-9]{32}$/.test(value.name) ||
    !object(value.job) ||
    !positive(value.job.repository) ||
    !positive(value.job.run) ||
    !positive(value.job.job) ||
    !Number.isSafeInteger(value.createdAt) ||
    (value.createdAt as number) < 0 ||
    !object(value.box) ||
    !object(value.runner) ||
    !['none', 'requested', 'done'].includes(value.delivery as string) ||
    typeof value.closing !== 'boolean'
  )
    throw new StateCorrupt()
  for (const [kind, resource] of [
    ['box', value.box],
    ['runner', value.runner],
  ] as const) {
    if (!['none', 'requested', 'known', 'absent'].includes(resource.phase as string)) throw new StateCorrupt()
    const validId =
      kind === 'box'
        ? typeof resource.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(resource.id)
        : positive(resource.id)
    if (
      resource.phase === 'none' || resource.phase === 'requested'
        ? resource.id !== null
        : resource.phase === 'known'
          ? !validId
          : resource.id !== null && !validId
    )
      throw new StateCorrupt()
  }
  if (
    (value.runner.phase !== 'none' && value.runner.phase !== 'absent' && value.box.id === null) ||
    (value.delivery !== 'none' && (value.box.id === null || value.runner.id === null))
  )
    throw new StateCorrupt()
  if (
    value.effect !== null &&
    (!object(value.effect) ||
      typeof value.effect.id !== 'string' ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.effect.id) ||
      !['box-create', 'box-stop', 'box-remove', 'runner-register', 'runner-remove', 'jit-deliver'].includes(
        value.effect.kind as string,
      ))
  )
    throw new StateCorrupt()
  if (
    value.effect === null &&
    (value.box.phase === 'requested' ||
      value.runner.phase === 'requested' ||
      value.box.id !== null ||
      value.runner.id !== null ||
      value.delivery !== 'none')
  )
    throw new StateCorrupt()
  return {
    scope: value.scope,
    name: value.name,
    job: { repository: value.job.repository, run: value.job.run, job: value.job.job },
    createdAt: value.createdAt as number,
    box: { phase: value.box.phase as ResourcePhase, id: value.box.id as string | null },
    runner: { phase: value.runner.phase as ResourcePhase, id: value.runner.id as number | null },
    delivery: value.delivery as Allocation['delivery'],
    closing: value.closing,
    effect: object(value.effect) ? { id: value.effect.id as string, kind: value.effect.kind as EffectKind } : null,
  }
}
