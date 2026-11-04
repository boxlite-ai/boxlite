/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { ListenerCredentials } from './credentials'
import { GitHubCredential, GitHubInstallation } from './github-app'
import { decodeRepository, GitHubRepository } from './jobs'
import { decodeScope, ExecutionScope, object, positive } from './execution/model'

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
  private readonly policy: { allowPublic: boolean; group: string }
  constructor(
    private readonly credentials: ListenerCredentials,
    binding: InstallationBinding,
    policy: { allowPublic: boolean; group: string },
  ) {
    this.binding = {
      ...binding,
      installation: {
        ...binding.installation,
        account: { ...binding.installation.account },
        permissions: { ...binding.installation.permissions },
      },
    }
    if (typeof policy.allowPublic !== 'boolean' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(policy.group))
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
    const eligible = installed.filter((repository) => repository.private || this.policy.allowPublic)
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
        decodeScope({ ...base, runners: { kind: 'repository', repository, allowPublic: this.policy.allowPublic } }),
      )
    if (!eligible.length) return []
    const borrow = await this.credentials.open({ kind: 'organization-runners' }, signal)
    try {
      const route = `/orgs/${original.installation.account.login}`,
        groups = await this.list(borrow.credential, `${route}/actions/runner-groups`, 'runner_groups', signal),
        matches = groups.filter((group) => object(group) && group.name === this.policy.group)
      if (matches.length !== 1 || !object(matches[0]))
        throw new Error('Configured CI runner group is missing or ambiguous')
      const group = matches[0]
      if (
        !positive(group.id) ||
        group.visibility !== 'selected' ||
        group.inherited !== false ||
        group.restricted_to_workflows !== false ||
        group.allows_public_repositories !== this.policy.allowPublic
      )
        throw new Error('CI runner group must match the explicit repository policy')
      const selected = (
        await this.list(
          borrow.credential,
          `${route}/actions/runner-groups/${group.id}/repositories`,
          'repositories',
          signal,
        )
      ).map((value) => this.repository(value))
      const expected = new Map(eligible.map((repository) => [repository.id, repository]))
      for (const repository of selected) {
        const installed = expected.get(repository.id)
        if (
          !installed ||
          installed.name.toLowerCase() !== repository.name.toLowerCase() ||
          installed.private !== repository.private
        )
          throw new Error('CI runner group differs from installed repositories')
        expected.delete(repository.id)
      }
      if (expected.size) throw new Error('CI runner group omits installed repositories')
      return [
        decodeScope({
          ...base,
          runners: {
            kind: 'organization',
            account: original.installation.account,
            group: group.id,
            repositories: selected.map((repository) => repository.id),
            allowPublic: this.policy.allowPublic,
          },
        }),
      ]
    } finally {
      await borrow.close()
    }
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
