/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { useUpgradePlanMutation } from '@/hooks/mutations/useUpgradePlanMutation'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { handleApiError } from '@/lib/error-handling'
import { clearPendingPlanUpgrade, type PendingPlanUpgrade } from '@/lib/pending-plan-upgrade'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { useEffect } from 'react'
import { useAuth } from 'react-oidc-context'
import { toast } from 'sonner'

export function PlanUpgradeReturn({ selection, onFinish }: { selection: PendingPlanUpgrade; onFinish: () => void }) {
  const { user } = useAuth()
  const { selectedOrganization, organizationMembersStatus, authenticatedUserOrganizationMember } =
    useSelectedOrganization()
  const { billingApi } = useApi()
  const { mutateAsync: upgrade } = useUpgradePlanMutation()
  const organizationId = selectedOrganization?.id
  const userId = user?.profile.sub
  const isOwner = authenticatedUserOrganizationMember?.role === OrganizationUserRoleEnum.OWNER

  useEffect(() => {
    if (!userId || !organizationId || organizationMembersStatus === 'loading') return
    let active = true
    async function resume() {
      try {
        if (
          organizationId !== selection.organizationId ||
          userId !== selection.userId ||
          organizationMembersStatus !== 'ready' ||
          !isOwner ||
          selection.expiresAt <= Date.now()
        ) {
          return
        }

        let wallet = await billingApi.getOrganizationWallet(organizationId)
        // The browser can return before card verification reaches the wallet.
        for (let attempt = 0; active && !wallet.creditCardConnected && attempt < 2; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 1000))
          if (!active) return
          wallet = await billingApi.getOrganizationWallet(organizationId)
        }
        if (!active || !wallet.creditCardConnected) return
        const plan = await billingApi.getOrganizationPlan(organizationId)
        if (!active || (plan?.planId === selection.planId && plan.status !== 'canceled')) return
        if (selection.expiresAt <= Date.now() || !clearPendingPlanUpgrade(selection)) return

        const url = await upgrade({ organizationId, planId: selection.planId })
        if (!active) return
        if (url) window.location.href = url
        else toast.success('Plan upgraded successfully')
      } catch (error) {
        if (active) handleApiError(error, 'Could not complete the plan upgrade')
      } finally {
        if (active) {
          clearPendingPlanUpgrade(selection)
          onFinish()
        }
      }
    }
    void resume()
    return () => {
      active = false
    }
  }, [billingApi, isOwner, onFinish, organizationId, organizationMembersStatus, selection, upgrade, userId])

  return (
    <div className="page-container py-6" role="status">
      Checking your plan upgrade…
    </div>
  )
}
