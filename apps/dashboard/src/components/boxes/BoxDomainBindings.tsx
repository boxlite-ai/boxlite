/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useQuery } from '@tanstack/react-query'
import { CopyButton } from '@/components/CopyButton'
import { Button } from '@/components/ui/button'
import { ArrowRightIcon, ExternalLink } from '@/components/ui/icon'
import { queryKeys } from '@/hooks/queries/queryKeys'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'

/** Domain responses are external URLs, not arbitrary navigable schemes or credentials. */
function safeDomainUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return value
  } catch {
    // Malformed URLs remain visible as bindings, without URL actions.
  }
  return undefined
}

/** Organization-owned domain bindings for this Box; not a tunnel or health inventory. */
export function BoxDomainBindings({ boxId, canManage }: { boxId: string; canManage: boolean }) {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  const organizationId = selectedOrganization?.id ?? ''
  const query = useQuery({
    queryKey: queryKeys.domains.list(organizationId),
    queryFn: () => api.listDomains(organizationId),
    enabled: Boolean(organizationId) && canManage,
    // The app default keeps previous query data, which must not cross organizations here.
    placeholderData: undefined,
  })
  const bindings = query.data?.domains.flatMap((domain) =>
    domain.target?.type === 'box' && domain.target.box === boxId ? [{ ...domain, port: domain.target.port }] : [],
  )

  return (
    <section aria-label="Bound domains" className="mt-5 border-t border-border/40 pt-3">
      <h3 className="mb-2 text-body font-medium">Domains</h3>
      {!canManage ? (
        <p className="text-meta text-muted-foreground">Domain bindings require management permission.</p>
      ) : !organizationId ? (
        <p className="text-meta text-muted-foreground">Select an organization to view domains.</p>
      ) : query.isPending ? (
        <p role="status" className="text-meta text-muted-foreground">
          Loading domains…
        </p>
      ) : (
        <>
          {query.isError && (
            <div role="status" className="flex items-center justify-between gap-2 text-meta text-muted-foreground">
              <span>{query.data ? 'Could not refresh domains.' : 'Could not load domains.'}</span>
              <Button variant="ghost" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>
                Retry
              </Button>
            </div>
          )}
          {bindings && bindings.length > 0 ? (
            <ul className="divide-y divide-border/35">
              {bindings.map((binding) => {
                const url = safeDomainUrl(binding.url)
                return (
                  <li
                    key={binding.hostname}
                    className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 py-1 text-meta"
                  >
                    <span title={binding.hostname} className="truncate font-mono">
                      {binding.hostname}
                    </span>
                    <span
                      aria-label={`Box port ${binding.port}`}
                      title={`Box port ${binding.port}`}
                      className="flex items-center gap-1 font-mono text-muted-foreground"
                    >
                      <ArrowRightIcon aria-hidden="true" className="size-3" />:{binding.port}
                    </span>
                    <div className="flex items-center">
                      {url && (
                        <>
                          <CopyButton value={url} size="icon-xs" tooltipText={`Copy URL for ${binding.hostname}`} />
                          <Button asChild variant="ghost" size="icon-xs">
                            <a
                              href={url}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={`Open ${binding.hostname}`}
                              title={`Open ${binding.hostname}`}
                            >
                              <ExternalLink className="size-3.5" />
                            </a>
                          </Button>
                        </>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          ) : (
            !query.isError && <p className="text-meta text-muted-foreground">No domains bound.</p>
          )}
        </>
      )}
    </section>
  )
}
