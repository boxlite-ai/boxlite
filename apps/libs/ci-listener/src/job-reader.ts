/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { ListenerCredentials } from './credentials'
import { decodeScope, ExecutionScope } from './execution/model'
import { decodeRepository, GitHubJobs, GitHubRepository } from './jobs'

/** Common read boundary; authorization and credentials belong to the caller's lease. */
export async function readRepositoryJobs<T>(
  original: ExecutionScope,
  credentials: ListenerCredentials,
  authorize: (signal?: AbortSignal) => Promise<void>,
  repositoryId: number,
  read: (jobs: GitHubJobs) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const scope = decodeScope(original)
  if (
    scope.runners.kind === 'repository'
      ? scope.runners.repository.id !== repositoryId
      : !scope.runners.repositories.includes(repositoryId)
  )
    throw new Error('Job is outside the original execution scope')
  await authorize(signal)
  const borrow = await credentials.open({ kind: 'jobs', repository: repositoryId }, signal)
  try {
    const repository: GitHubRepository = decodeRepository(
      await borrow.credential.request(`/repositories/${repositoryId}`, { signal }),
    )
    {
      const account = scope.installation.account
      if (
        repository.id !== repositoryId ||
        repository.owner.id !== account.id ||
        repository.owner.login.toLowerCase() !== account.login
      )
        throw new Error('GitHub job repository authority changed')
      if (
        scope.runners.kind === 'repository' &&
        (repository.name.toLowerCase() !== scope.runners.repository.name.toLowerCase() ||
          repository.private !== scope.runners.repository.private)
      )
        throw new Error('Original job repository changed')
    }
    if (repository.private ? !scope.runners.allowPrivate : !scope.runners.allowPublic)
      throw new Error('Repository visibility is disabled')
    const result = await read(new GitHubJobs(borrow.credential, repository))
    await authorize(signal)
    return result
  } finally {
    await borrow.close()
  }
}
