/* Copyright 2026 BoxLite AI. SPDX-License-Identifier: AGPL-3.0 */
import { createContext, useContext, useRef, useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from 'react-oidc-context'
import { useApi } from '@/hooks/useApi'
import { useConfig } from '@/hooks/useConfig'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { useConsoleAnalytics } from '@/hooks/useConsoleAnalytics'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { analyticsNoticeVersion, type AnalyticsPreference } from '../../../shared/console-analytics'

type ConsolePreference = AnalyticsPreference & { enabledFrom: string | null }
type Choice = {
  allowed: boolean | null | undefined
  saving: boolean
  error: string | null
  save: (allowed: boolean) => void
  refresh: () => void
}
const Preferences = createContext<Choice | null>(null)

export function ProductAnalyticsProvider({ children }: { children: ReactNode }) {
  const { user, isAuthenticated } = useAuth()
  const { selectedOrganization } = useSelectedOrganization()
  const { posthog } = useConfig()
  const sub = isAuthenticated && user?.profile.sub
  if (!sub || !selectedOrganization?.id || !posthog?.host || !posthog.apiKey) return children
  return (
    <AccountPreference
      key={JSON.stringify([sub, selectedOrganization.id])}
      sub={sub}
      organizationId={selectedOrganization.id}
    >
      {children}
    </AccountPreference>
  )
}

function AccountPreference({
  sub,
  organizationId,
  children,
}: {
  sub: string
  organizationId: string
  children: ReactNode
}) {
  const api = useApi()
  const queryClient = useQueryClient()
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const writing = useRef(false)
  const query = useQuery({
    queryKey: ['product-analytics', sub, organizationId],
    queryFn: async ({ signal }): Promise<ConsolePreference> => {
      const http = api.axiosInstance
      return (await http.get('/analytics/organizations/' + encodeURIComponent(organizationId) + '/consent', { signal }))
        .data
    },
    retry: false,
    refetchOnMount: 'always',
  })
  const allowed = query.data?.allowed
  useConsoleAnalytics(organizationId, query.isError ? null : query.data?.enabledFrom)

  const save = async (next: boolean) => {
    if (writing.current) return
    writing.current = true
    setSaving(true)
    setSaveError(null)
    try {
      const { data: decision } = await api.axiosInstance.put<AnalyticsPreference>('/analytics/consent', {
        allowed: next,
        version: analyticsNoticeVersion,
      })
      const accountQueries = { queryKey: ['product-analytics', sub] }
      // Discard consent reads that started before the decision was saved.
      await queryClient.cancelQueries(accountQueries)
      if (decision.allowed === false) {
        queryClient.setQueriesData<ConsolePreference>(accountQueries, { ...decision, enabledFrom: null })
      } else {
        // A personal grant still needs the organization's creator grant.
        await queryClient.invalidateQueries(accountQueries)
      }
    } catch {
      setSaveError('Could not confirm your preference. Check your connection and try again.')
    } finally {
      setSaving(false)
      writing.current = false
    }
  }
  return (
    <Preferences.Provider
      value={{
        allowed,
        saving,
        save,
        error: saveError || (query.isError ? 'Could not load your preference.' : null),
        refresh: () => void query.refetch(),
      }}
    >
      {children}
    </Preferences.Provider>
  )
}

export function AnalyticsConsentCard() {
  const choice = useContext(Preferences)
  if (!choice || choice.allowed !== null) return null
  return (
    <section
      data-analytics-preferences
      aria-labelledby="analytics-card-title"
      className="mx-4 my-3 max-w-xl border border-border bg-background p-4 sm:mx-5"
    >
      <h2 id="analytics-card-title" className="text-body font-semibold">
        Share usage analytics?
      </h2>
      <p className="mt-1 text-body text-muted-foreground">
        Allow BoxLite to send Console page visits and feature interactions to PostHog to help improve the product. You
        can turn this off anytime in Settings.
      </p>
      <details className="mt-2 text-meta text-muted-foreground">
        <summary className="cursor-pointer">What this choice covers</summary>Your choice covers your account activity
        and Cloud activity in organizations you created. Activity linked to another member also needs their permission.
      </details>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="outline" disabled={choice.saving} onClick={() => choice.save(true)}>
          Allow analytics
        </Button>
        <Button variant="outline" disabled={choice.saving} onClick={() => choice.save(false)}>
          No thanks
        </Button>
      </div>
      {choice.error && (
        <p role="alert" className="mt-2 text-meta text-destructive">
          {choice.error}
        </p>
      )}
    </section>
  )
}

export function ProductAnalyticsSettings() {
  const choice = useContext(Preferences)
  return (
    <section data-analytics-preferences aria-labelledby="privacy-preferences" className="border border-border p-5">
      <h2 id="privacy-preferences" className="text-em font-semibold">
        Privacy Preferences
      </h2>
      <div className="mt-4 flex items-start justify-between gap-4">
        <div>
          <label htmlFor="product-analytics" className="text-body font-semibold">
            Product analytics
          </label>
          <p id="analytics-scope" className="mt-1 max-w-lg text-meta text-muted-foreground">
            Share usage with PostHog for your account and the organizations you created. Other members must also agree
            before their activity is shared.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span aria-live="polite" className="text-meta">
            {!choice
              ? 'Unavailable'
              : choice.saving
                ? 'Saving…'
                : choice.allowed === undefined
                  ? choice.error
                    ? 'Unavailable'
                    : 'Loading…'
                  : choice.allowed
                    ? 'On'
                    : 'Off'}
          </span>
          <Switch
            id="product-analytics"
            aria-describedby="analytics-scope"
            checked={choice?.allowed === true}
            disabled={!choice || choice.saving || choice.allowed === undefined}
            onCheckedChange={(value) => choice?.save(value)}
          />
        </div>
      </div>
      {choice?.error && (
        <div className="mt-2 flex items-center gap-2">
          <p role="alert" className="text-meta text-destructive">
            {choice.error}
          </p>
          <Button variant="outline" size="sm" onClick={choice.refresh}>
            Refresh
          </Button>
        </div>
      )}
    </section>
  )
}
