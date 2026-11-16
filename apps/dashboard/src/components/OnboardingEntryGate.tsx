/* Copyright BoxLite AI, 2026 · SPDX-License-Identifier: AGPL-3.0 */
import { useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from 'react-oidc-context'
import { matchPath, Navigate, useLocation } from 'react-router-dom'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { RoutePath } from '@/enums/RoutePath'
import { LocalStorageKey } from '@/enums/LocalStorageKey'
import { shouldAutoOpenOnboarding } from '@/lib/onboarding-visibility'
import { getLocalStorageItem } from '@/lib/local-storage'
import { Button } from './ui/button'
import { SetupLayout, SetupPending } from './SetupLayout'

/** Resolve default entry before mounting navigation; explicit resource links keep their destination. */
export function OnboardingEntryGate({ children }: { children: ReactNode }) {
  const { pathname, search } = useLocation()
  const { user } = useAuth()
  const { selectedOrganization } = useSelectedOrganization()
  if (!selectedOrganization || !user) return children
  return (
    <AccountEntry
      key={`${user.profile.sub}:${selectedOrganization.id}`}
      userId={user.profile.sub}
      orgId={selectedOrganization.id}
      checkEntry={Boolean(matchPath(RoutePath.DASHBOARD, pathname) || matchPath(RoutePath.BOXES, pathname))}
      isWelcome={Boolean(matchPath(RoutePath.WELCOME, pathname))}
      requested={new URLSearchParams(search).get('onboarding') === '1'}
    >
      {children}
    </AccountEntry>
  )
}

function AccountEntry({
  userId,
  orgId,
  checkEntry,
  isWelcome,
  requested,
  children,
}: {
  userId: string
  orgId: string
  checkEntry: boolean
  isWelcome: boolean
  requested: boolean
  children: ReactNode
}) {
  const api = useApi()
  const [admitted, setAdmitted] = useState(false)
  const dismissed = getLocalStorageItem(`${LocalStorageKey.SkipOnboardingPrefix}${userId}`) === 'true'
  const decision = useQuery({
    queryKey: ['onboarding-entry', userId, orgId],
    enabled: checkEntry && !requested && !dismissed && !admitted,
    retry: false,
    placeholderData: undefined,
    staleTime: 0,
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const options = { signal, timeout: 10_000 }
      const members = (await api.organizationsApi.listOrganizationMembers(orgId, options)).data
      if (members.find((member) => member.userId === userId)?.role !== OrganizationUserRoleEnum.OWNER) return false
      const boxRequest: Parameters<typeof api.boxApi.listBoxesPaginated> = [orgId, 1, 1]
      boxRequest[19] = options
      const [keys, boxes] = await Promise.all([
        api.apiKeyApi.listApiKeys(orgId, options),
        api.boxApi.listBoxesPaginated(...boxRequest),
      ])
      return shouldAutoOpenOnboarding({
        requestedByUrl: false,
        canCompleteWelcome: true,
        dismissedInThisBrowser: false,
        accountStateLoaded: true,
        hasApiKeys: keys.data.length > 0,
        hasBoxes: boxes.data.total > 0,
      })
    },
  })
  if (!checkEntry) {
    // A resource deep link already exposes Console; keep that navigation mounted.
    if (!isWelcome && !requested && !admitted) setAdmitted(true)
    return children
  }
  if (requested) return <Navigate to={RoutePath.QUICKSTART} replace />
  if (dismissed || admitted) return children
  if (decision.isPending || decision.isFetching || !decision.isFetchedAfterMount) return <SetupPending />
  if (decision.isError)
    return (
      <SetupLayout
        title="We couldn’t prepare your organization"
        description="Your account is available. Try checking your setup again."
      >
        <p role="alert" className="mb-5 text-body text-destructive">
          Organization details could not be loaded.
        </p>
        <Button onClick={() => void decision.refetch()}>Try again</Button>
      </SetupLayout>
    )
  if (decision.data) return <Navigate to={RoutePath.WELCOME} replace />
  setAdmitted(true)
  return children
}
