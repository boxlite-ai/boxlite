/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { GitHubAppSource, GitHubCredential } from './github-app'
import { decodeRepository, GitHubRepository } from './jobs'
import type { VerifiedInstallation } from './ci-gh-app'
import { GitHubRequestError } from './github'

export function installationSettingsUrl(installation: VerifiedInstallation): string {
  if (
    !Number.isSafeInteger(installation.installationId) ||
    installation.installationId <= 0 ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(installation.accountLogin) ||
    !['User', 'Organization'].includes(installation.accountType)
  )
    throw new Error('Invalid installation settings identity')
  return installation.accountType === 'User'
    ? `https://github.com/settings/installations/${installation.installationId}`
    : `https://github.com/organizations/${installation.accountLogin}/settings/installations/${installation.installationId}`
}

export interface InstallationRepositoryPage {
  repositories: GitHubRepository[]
  total: number
  page: number
  next_page: number | null
  repository_selection: 'all' | 'selected'
  installation_settings_url: string
}
type HeldCredential = {
  credential?: GitHubCredential
  expires?: number
  retiring?: Promise<void>
  retirementWanted?: boolean
}

/** Metadata requests own their handles independently of execution leases and browser cancellation. */
export class InstallationRepositoryReader {
  private closed = false
  private readonly held = new Set<HeldCredential>()
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly cooldown = new Map<number, number>()
  private retry?: ReturnType<typeof setInterval>
  constructor(private readonly report: () => void = () => undefined) {}

  async page(
    source: GitHubAppSource,
    expected: VerifiedInstallation,
    page = 1,
    limit = 25,
    signal?: AbortSignal,
  ): Promise<InstallationRepositoryPage> {
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > Math.floor(Number.MAX_SAFE_INTEGER / 100) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new Error('Invalid repository page')
    const settings = installationSettingsUrl(expected)
    for (const [id, until] of this.cooldown) if (until <= Date.now()) this.cooldown.delete(id)
    if (
      this.closed ||
      this.held.size >= 32 ||
      this.cooldown.size >= 10000 ||
      this.cooldown.has(expected.installationId)
    )
      throw new Error('Repository access is busy; retry later')
    // Reserve before the first await; in-flight issuance counts toward the handle limit.
    const held: HeldCredential = {}
    this.held.add(held)
    const task = this.read(source, { ...expected }, held, page, limit, settings, signal)
    this.tasks.add(task)
    try {
      return await task
    } finally {
      this.tasks.delete(task)
    }
  }
  private async read(
    source: GitHubAppSource,
    expected: VerifiedInstallation,
    held: HeldCredential,
    page: number,
    limit: number,
    settings: string,
    external?: AbortSignal,
  ): Promise<InstallationRepositoryPage> {
    const signal = AbortSignal.any([AbortSignal.timeout(45000), ...(external ? [external] : [])])
    try {
      const installation = await source.installation(expected.installationId, signal)
      if (
        installation.suspended ||
        installation.account.id !== expected.accountId ||
        installation.account.type !== expected.accountType ||
        installation.account.login.toLowerCase() !== expected.accountLogin.toLowerCase()
      )
        throw new Error('Original GitHub installation changed')
      if (!installation.repositorySelection) throw new Error('Missing repository selection mode')
      try {
        held.credential = await source.issue(installation, { kind: 'catalog' }, signal)
      } catch (error) {
        if (error instanceof GitHubRequestError && error.uncertain)
          this.cooldown.set(expected.installationId, Date.now() + 60000)
        throw error
      }
      // Invalid metadata still leaves a live revocation handle, including on a late response after cancellation.
      if (!held.credential.usable) throw new Error('Invalid metadata credential')
      held.expires = held.credential.expiresAt ?? undefined
      signal.throwIfAborted()
      const raw = await held.credential.request(`/installation/repositories?per_page=${limit}&page=${page}`, { signal })
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid repository inventory')
      const value = raw as Record<string, unknown>,
        total = value.total_count
      if (
        !Number.isSafeInteger(total) ||
        (total as number) < 0 ||
        (total as number) > 100000 ||
        !Array.isArray(value.repositories) ||
        value.repositories.length !== Math.min(limit, Math.max(0, (total as number) - (page - 1) * limit))
      )
        throw new Error('Incomplete repository page')
      const repositories = value.repositories.map(decodeRepository)
      if (
        new Set(repositories.map((repo) => repo.id)).size !== repositories.length ||
        repositories.some(
          (repo) =>
            repo.owner.id !== expected.accountId ||
            repo.owner.login.toLowerCase() !== expected.accountLogin.toLowerCase(),
        )
      )
        throw new Error('Repository account authority changed')
      return {
        repositories,
        total: total as number,
        page,
        next_page: page * limit < (total as number) ? page + 1 : null,
        repository_selection: installation.repositorySelection,
        installation_settings_url: settings,
      }
    } finally {
      if (held.credential) await this.retire(held)
      else this.held.delete(held)
    }
  }
  private async retire(held: HeldCredential): Promise<void> {
    held.retirementWanted = true
    if (held.retiring) return held.retiring
    if (held.expires !== undefined && Date.now() >= held.expires) {
      this.held.delete(held)
      return
    }
    const task = (async () => {
      try {
        await held.credential!.close()
        this.held.delete(held)
      } catch {
        this.report()
        if (!this.closed && !this.retry) {
          this.retry = setInterval(() => {
            void Promise.all([...this.held].filter((item) => item.retirementWanted).map((item) => this.retire(item)))
          }, 30000)
          this.retry.unref()
        }
      }
    })()
    held.retiring = task
    try {
      await task
    } finally {
      held.retiring = undefined
    }
  }
  async close(): Promise<void> {
    this.closed = true
    if (this.retry) clearInterval(this.retry)
    await Promise.allSettled([...this.tasks])
    await Promise.all([...this.held].filter((held) => held.credential).map((held) => this.retire(held)))
    if (this.held.size) throw new Error('Metadata credential retirement remains pending')
  }
}
