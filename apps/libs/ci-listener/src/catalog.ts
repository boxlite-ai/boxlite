/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { ListenerCredentials } from './credentials'
import { GitHubCredential, GitHubInstallation } from './github-app'
import { decodeRepository, GitHubRepository } from './jobs'
import { decodeScope, ExecutionScope, object, positive } from './execution/model'
import { Json } from './state/database'

export interface RunnerGroupMutation {
  method: 'POST' | 'PATCH' | 'PUT'
  path: string
  body: Json
}

export interface InstallationBinding {
  binding: string
  generation: number
  organization: string
  actor: string
  installation: GitHubInstallation
}

/** Complete inventories only; a failed snapshot never becomes an empty installation. */
export class InstallationCatalog {
  private readonly binding: InstallationBinding
  private readonly policy: { allowPublic: boolean; allowPrivate: boolean; group: string }
  constructor(
    private readonly credentials: ListenerCredentials,
    binding: InstallationBinding,
    policy: { allowPublic: boolean; allowPrivate: boolean; group: string },
    private readonly beforeMutation?: (effect: RunnerGroupMutation) => Promise<void>,
  ) {
    this.binding = {
      ...binding,
      installation: {
        ...binding.installation,
        account: { ...binding.installation.account },
        permissions: { ...binding.installation.permissions },
      },
    }
    if (
      typeof policy.allowPublic !== 'boolean' ||
      typeof policy.allowPrivate !== 'boolean' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(policy.group)
    )
      throw new Error('Invalid CI repository/group policy')
    this.policy = { ...policy }
  }
  async load(signal?: AbortSignal): Promise<ExecutionScope[]> {
    if (this.binding.installation.suspended) throw new Error('GitHub installation is suspended')
    const catalog = await this.credentials.open({ kind: 'catalog' }, signal)
    let installed: GitHubRepository[]
    try {
      installed = (await this.list(catalog.credential, '/installation/repositories', 'repositories', signal)).map(
        (value) => this.repository(value),
      )
    } finally {
      await catalog.close()
    }
    const eligible = installed.filter((repository) =>
      repository.private ? this.policy.allowPrivate : this.policy.allowPublic,
    )
    const original = this.binding
    const base = {
      binding: original.binding,
      generation: original.generation,
      organization: original.organization,
      actor: original.actor,
      installation: { id: original.installation.id, account: original.installation.account },
    }
    if (original.installation.account.type === 'User')
      return eligible.map((repository) =>
        decodeScope({
          ...base,
          runners: {
            kind: 'repository',
            repository,
            allowPrivate: this.policy.allowPrivate,
            allowPublic: this.policy.allowPublic,
          },
        }),
      )
    const borrow = await this.credentials.open({ kind: 'organization-runners' }, signal)
    try {
      const group = await this.synchronizeGroup(borrow.credential, eligible, signal)
      if (group === undefined || !eligible.length) return []
      return [
        decodeScope({
          ...base,
          runners: {
            kind: 'organization',
            account: original.installation.account,
            group,
            repositories: eligible.map((repository) => repository.id),
            allowPrivate: this.policy.allowPrivate,
            allowPublic: this.policy.allowPublic,
          },
        }),
      ]
    } finally {
      await borrow.close()
    }
  }
  private managedGroup(value: unknown): Record<string, unknown> & { id: number } {
    if (
      !object(value) ||
      !positive(value.id) ||
      value.name !== this.policy.group ||
      value.default !== false ||
      value.inherited !== false ||
      !['selected', 'all', 'private'].includes(value.visibility as string) ||
      typeof value.allows_public_repositories !== 'boolean' ||
      typeof value.restricted_to_workflows !== 'boolean'
    )
      throw new Error('CI managed runner group is invalid, default or inherited')
    return value as Record<string, unknown> & { id: number }
  }
  private async synchronizeGroup(
    credential: GitHubCredential,
    eligible: GitHubRepository[],
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    const route = `/orgs/${this.binding.installation.account.login}/actions/runner-groups`,
      groups = await this.list(credential, route, 'runner_groups', signal),
      matches = groups.filter((group) => object(group) && group.name === this.policy.group),
      ids = eligible.map((repository) => repository.id)
    if (matches.length > 1) throw new Error('CI managed runner group is ambiguous')
    if (!matches.length && !ids.length) return undefined
    const policy = (allowPublic: boolean) => ({
      name: this.policy.group,
      visibility: 'selected',
      allows_public_repositories: allowPublic,
      restricted_to_workflows: false,
      selected_workflows: [],
    })
    let group = this.managedGroup(
      matches[0] ??
        (await this.mutateGroup(
          credential,
          {
            method: 'POST',
            path: route,
            body: { ...policy(this.policy.allowPublic), selected_repository_ids: ids },
          },
          signal,
        )),
    )
    const id = group.id,
      path = `${route}/${id}`,
      readRepositories = async () =>
        (await this.list(credential, path + '/repositories', 'repositories', signal)).map((value) =>
          this.repository(value),
        ),
      selected = await readRepositories(),
      expected = new Set(ids)
    // Revoke broad access before changing membership; enable public access only after membership converges.
    if (
      group.visibility !== 'selected' ||
      group.restricted_to_workflows ||
      (group.allows_public_repositories && !this.policy.allowPublic)
    )
      group = this.managedGroup(
        await this.mutateGroup(credential, { method: 'PATCH', path, body: policy(false) }, signal),
      )
    if (selected.length !== ids.length || selected.some((repository) => !expected.has(repository.id)))
      await this.mutateGroup(
        credential,
        { method: 'PUT', path: path + '/repositories', body: { selected_repository_ids: ids } },
        signal,
      )
    if (group.allows_public_repositories !== this.policy.allowPublic)
      await this.mutateGroup(credential, { method: 'PATCH', path, body: policy(this.policy.allowPublic) }, signal)
    group = this.managedGroup(await credential.request(path, { signal }))
    if (
      group.id !== id ||
      group.visibility !== 'selected' ||
      group.restricted_to_workflows ||
      group.allows_public_repositories !== this.policy.allowPublic
    )
      throw new Error('CI runner group policy readback differs from the connection')
    const actual = await readRepositories(),
      installed = new Map(eligible.map((repository) => [repository.id, repository]))
    for (const repository of actual) {
      const original = installed.get(repository.id)
      if (
        !original ||
        original.name.toLowerCase() !== repository.name.toLowerCase() ||
        original.private !== repository.private
      )
        throw new Error('CI runner group policy readback differs from installed repositories')
      installed.delete(repository.id)
    }
    if (installed.size) throw new Error('CI runner group policy readback omits installed repositories')
    return id
  }
  private async mutateGroup(
    credential: GitHubCredential,
    effect: RunnerGroupMutation,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.beforeMutation) throw new Error('CI managed runner group synchronization requires host authority')
    signal?.throwIfAborted()
    await this.beforeMutation(effect)
    signal?.throwIfAborted()
    return credential.request(effect.path, {
      method: effect.method,
      json: effect.body,
      signal,
      response: effect.method === 'PUT' ? 'empty' : 'json',
    })
  }
  private repository(value: unknown): GitHubRepository {
    const repository = decodeRepository(value),
      account = this.binding.installation.account
    if (repository.owner.id !== account.id || repository.owner.login.toLowerCase() !== account.login.toLowerCase())
      throw new Error('Repository no longer belongs to the installation account')
    return repository
  }
  private async list(
    credential: GitHubCredential,
    route: string,
    field: 'repositories' | 'runner_groups',
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    const result: unknown[] = [],
      seen = new Set<number>()
    let total: number | undefined
    for (let page = 1; page <= 1000; page++) {
      const value = await credential.request(`${route}?per_page=100&page=${page}`, { signal })
      if (
        !object(value) ||
        !Number.isSafeInteger(value.total_count) ||
        (value.total_count as number) < 0 ||
        (value.total_count as number) > 100000 ||
        (total !== undefined && total !== value.total_count) ||
        !Array.isArray(value[field]) ||
        value[field].length > 100
      )
        throw new Error('Incomplete GitHub installation directory')
      total = value.total_count as number
      for (const item of value[field]) {
        if (!object(item) || !positive(item.id) || seen.has(item.id))
          throw new Error('Invalid or duplicate installation inventory')
        seen.add(item.id)
        result.push(item)
      }
      if (result.length > total || (result.length < total && value[field].length < 100))
        throw new Error('Incomplete GitHub installation directory')
      if (result.length === total) return result
    }
    throw new Error('GitHub installation inventory exceeds limit')
  }
}
