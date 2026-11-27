/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { useUpgradePlanMutation } from '@/hooks/mutations/useUpgradePlanMutation'
import { RoutePath } from '@/enums/RoutePath'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { handleApiError } from '@/lib/error-handling'
import { isActivePlan, recordWelcomeCompletion } from '@/lib/first-run'
import { clearPendingPlanUpgrade, rememberPlanUpgrade, type PendingPlanUpgrade } from '@/lib/pending-plan-upgrade'
import { OrganizationUserRoleEnum } from '@boxlite-ai/api-client'
import { useEffect } from 'react'
import { useAuth } from 'react-oidc-context'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

export function PlanUpgradeReturn({ selection, onFinish }: { selection: PendingPlanUpgrade; onFinish: () => void }) {
  const { user } = useAuth()
  const navigate = useNavigate()
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
      let destination: RoutePath.WELCOME | RoutePath.QUICKSTART | undefined
      const { planId, welcome } = selection
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

        if (welcome?.phase === 'setup') destination = RoutePath.WELCOME
        if (welcome?.phase !== 'payment') {
          let wallet = await billingApi.getOrganizationWallet(organizationId)
          // The browser can return before card verification reaches the wallet.
          for (let attempt = 0; active && !wallet.creditCardConnected && attempt < 2; attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 1000))
            if (!active) return
            wallet = await billingApi.getOrganizationWallet(organizationId)
          }
          if (!active || !wallet.creditCardConnected) return
        }
        const plan = await billingApi.getOrganizationPlan(organizationId)
        if (!active) return
        if (plan?.planId === planId && plan.status !== 'canceled') {
          destination = welcome && isActivePlan(plan, planId) ? RoutePath.QUICKSTART : undefined
          return
        }
        if (welcome?.phase === 'payment') {
          toast.info('Check Billing for your subscription status.')
          return
        }
        if (welcome) {
          if (plan && plan.status !== 'canceled') return
          const catalog = await billingApi.listPlans()
          if (!active) return
          if (
            !catalog.some(
              (plan) => plan.id === planId && plan.selfServe && plan.priceMonthlyCents === welcome.priceMonthlyCents,
            )
          ) {
            toast.info('The plan details changed. Review the subscription again.')
            return
          }
        }
        if (selection.expiresAt <= Date.now() || !clearPendingPlanUpgrade(selection)) return

        const url = await upgrade({ organizationId, planId })
        if (!active) return
        if (url) {
          if (welcome) {
            rememberPlanUpgrade({ ...selection, welcome: { ...welcome, phase: 'payment' } })
          }
          destination = undefined
          window.location.href = url
        } else if (welcome) {
          destination = undefined
          const activatedPlan = await billingApi.getOrganizationPlan(organizationId)
          if (isActivePlan(activatedPlan, planId)) destination = RoutePath.QUICKSTART
        } else {
          toast.success('Plan upgraded successfully')
        }
      } catch (error) {
        if (active) handleApiError(error, 'Could not complete the plan upgrade')
      } finally {
        if (active) {
          clearPendingPlanUpgrade(selection)
          onFinish()
          if (destination === RoutePath.QUICKSTART) {
            recordWelcomeCompletion(selection.userId, selection.organizationId)
          }
          if (destination) navigate(destination, { replace: true })
        }
      }
    }
    void resume()
    return () => {
      active = false
    }
  }, [billingApi, isOwner, navigate, onFinish, organizationId, organizationMembersStatus, selection, upgrade, userId])

  return (
    <div className="page-container py-6" role="status">
      Checking your plan upgrade…
    </div>
  )
}
