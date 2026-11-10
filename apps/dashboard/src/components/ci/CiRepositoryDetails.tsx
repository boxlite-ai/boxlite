/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiClient } from '@/api/apiClient'
import type { CiRepositoryContext } from '@/api/ci-types'
import { AsciiButton } from '@/components/ascii'
import { ExternalLink } from '@/components/ui/icon'

const refreshed = 'ci-repository-access-returned'

function settingsUrl(value: string | undefined, installation: number, account: string): string | undefined {
  try {
    const url = new URL(value!)
    if (
      url.protocol !== 'https:' ||
      url.host !== 'github.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return
    if (
      url.pathname !== `/settings/installations/${installation}` &&
      url.pathname !== `/organizations/${account}/settings/installations/${installation}`
    )
      return
    return url.href
  } catch {
    return
  }
}

/** Repository authorization is shown independently of the connection's CI visibility policy. */
export function CiRepositoryDetails({
  api,
  organization,
  context,
  installation,
  account,
  managementUrl,
}: {
  api: Pick<ApiClient, 'getCiRepositories'>
  organization: string
  context: CiRepositoryContext
  installation: number
  account: string
  managementUrl?: string
}) {
  const cache = useQueryClient(),
    [page, setPage] = useState(1),
    pendingReturn = useRef(false)
  const query = useQuery({
    queryKey: [
      'ci-repositories',
      organization,
      installation,
      context.kind,
      context.id,
      context.kind === 'grant' ? context.account : 0,
      page,
    ],
    queryFn: ({ signal }) => api.getCiRepositories(organization, context, page, signal),
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  })
  useEffect(() => {
    const returned = () => {
      if (!pendingReturn.current || document.visibilityState === 'hidden') return
      pendingReturn.current = false
      window.dispatchEvent(new CustomEvent(refreshed, { detail: { organization, installation } }))
    }
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent).detail
      if (detail?.organization !== organization || detail.installation !== installation) return
      const key = ['ci-repositories', organization, installation]
      void cache.cancelQueries({ queryKey: key }).then(async () => {
        await cache.invalidateQueries({ queryKey: key, refetchType: 'none' })
        setPage(1)
        // If already on page one, changing state cannot cause a new observer fetch.
        if (page === 1) await cache.refetchQueries({ queryKey: key, type: 'active' })
      })
    }
    window.addEventListener('focus', returned)
    document.addEventListener('visibilitychange', returned)
    window.addEventListener(refreshed, refresh)
    return () => {
      window.removeEventListener('focus', returned)
      document.removeEventListener('visibilitychange', returned)
      window.removeEventListener(refreshed, refresh)
    }
  }, [cache, organization, installation, page])
  const href = settingsUrl(managementUrl ?? query.data?.installation_settings_url, installation, account)
  return (
    <div
      className="space-y-3 border-l border-border py-3 pl-4 font-mono text-meta"
      aria-label={`Installed repositories for ${account}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-muted-foreground">
          {query.data
            ? `${query.data.repository_selection === 'all' ? 'All repositories' : 'Selected repositories'} · ${query.data.total}`
            : 'Installed repositories'}
        </span>
        {href && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            onClick={() => {
              pendingReturn.current = true
            }}
            className="inline-flex items-center gap-1.5 underline underline-offset-4 hover:text-foreground"
          >
            Install app for repos <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
      {query.isPending ? (
        <p role="status">Loading repositories…</p>
      ) : query.isError ? (
        <div>
          <p role="alert">Unable to load repositories.</p>
          <AsciiButton size="sm" onClick={() => void query.refetch()}>
            Retry
          </AsciiButton>
        </div>
      ) : (
        <ul className="space-y-2">
          {query.data.repositories.map((repo) => (
            <li key={repo.id} className="flex items-center justify-between gap-3">
              <span className="break-all">
                {repo.owner.login}/{repo.name}
              </span>
              <span className="shrink-0 text-muted-foreground">{repo.private ? 'Private' : 'Public'}</span>
            </li>
          ))}
          {!query.data.repositories.length && (
            <li className="text-muted-foreground">No repositories authorized for this App.</li>
          )}
        </ul>
      )}
      {(page > 1 || query.data?.next_page) && (
        <div className="flex items-center justify-end gap-3">
          <AsciiButton size="sm" disabled={page === 1 || query.isFetching} onClick={() => setPage(page - 1)}>
            Previous
          </AsciiButton>
          <span>Page {page}</span>
          <AsciiButton
            size="sm"
            disabled={!query.data?.next_page || query.isFetching}
            onClick={() => setPage(query.data!.next_page!)}
          >
            Next
          </AsciiButton>
        </div>
      )}
    </div>
  )
}
