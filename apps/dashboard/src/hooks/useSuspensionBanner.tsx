/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useBanner } from '@/components/Banner'
import { RoutePath } from '@/enums/RoutePath'
import { ApiClient } from '@/api/apiClient'
import { useConfig } from '@/hooks/useConfig'
import { useOrganizations } from '@/hooks/useOrganizations'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { Organization } from '@boxlite-ai/api-client'
import { addHours, formatDistanceToNow } from 'date-fns'
import { CreditCardIcon, MailIcon } from '@/components/ui/icon'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from 'react-oidc-context'
import { useLocation, useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

const SUSPENSION_BANNER_ID = 'suspension-banner'

// todo: enumerate reasons
const PAYMENT_METHOD_REQUIRED_REASON = 'Payment method required'
const VERIFY_EMAIL_REASON = 'Please verify your email address'
const CREDITS_DEPLETED_REASON = 'Credits depleted'

function isSetupRequiredSuspension(reason: string) {
  return reason === PAYMENT_METHOD_REQUIRED_REASON || reason === VERIFY_EMAIL_REASON
}

function isCreditsDepletionSuspension(reason: string) {
  return reason === CREDITS_DEPLETED_REASON
}

type Suspension = Pick<
  Organization,
  'suspended' | 'suspensionReason' | 'suspendedAt' | 'suspensionCleanupGracePeriodHours'
>

export function useSuspensionBanner(suspension?: Suspension | null) {
  const { addBanner, removeBanner } = useBanner()
  const navigate = useNavigate()
  const location = useLocation()
  const config = useConfig()
  const { signinSilent, removeUser, signinRedirect } = useAuth()
  const { refreshOrganizations } = useOrganizations()
  const { selectedOrganization, refreshOrganizationMembers } = useSelectedOrganization()
  const path = location?.pathname
  const previousSuspendedRef = useRef<boolean | undefined>(undefined)
  const [isCheckingVerification, setIsCheckingVerification] = useState(false)

  const redirectToFreshLogin = useCallback(async () => {
    await removeUser()
    await signinRedirect({
      state: {
        returnTo: `${location.pathname}${location.search}`,
      },
    })
  }, [location.pathname, location.search, removeUser, signinRedirect])

  const handleVerifyEmailRefresh = useCallback(async () => {
    if (isCheckingVerification) {
      return
    }

    setIsCheckingVerification(true)
    try {
      let freshUser
      try {
        freshUser = await signinSilent()
      } catch {
        await redirectToFreshLogin()
        return
      }

      if (!freshUser?.access_token || freshUser.profile.email_verified !== true) {
        toast.error('We could not confirm verification yet. Try again in a moment.')
        await redirectToFreshLogin()
        return
      }

      const api = new ApiClient(config, freshUser.access_token)
      await api.userApi.getAuthenticatedUser()
      await refreshOrganizations(selectedOrganization?.id)
      await refreshOrganizationMembers()
    } catch {
      toast.error('We could not refresh your account. Try again in a moment.')
    } finally {
      setIsCheckingVerification(false)
    }
  }, [
    config,
    isCheckingVerification,
    redirectToFreshLogin,
    refreshOrganizationMembers,
    refreshOrganizations,
    selectedOrganization?.id,
    signinSilent,
  ])

  useEffect(() => {
    const wasSuspended = previousSuspendedRef.current
    const isSuspended = suspension?.suspended ?? false

    if (wasSuspended && !isSuspended) {
      removeBanner(SUSPENSION_BANNER_ID)
      previousSuspendedRef.current = isSuspended
      return
    }

    previousSuspendedRef.current = isSuspended

    if (!isSuspended || !suspension?.suspensionReason) {
      return
    }

    const reason = suspension.suspensionReason

    if (isSetupRequiredSuspension(reason)) {
      if (reason === PAYMENT_METHOD_REQUIRED_REASON) {
        addBanner({
          id: SUSPENSION_BANNER_ID,
          variant: 'info',
          title: 'Setup Required',
          description: 'Add a payment method to start creating Boxes.',
          icon: <CreditCardIcon className="h-4 w-4 flex-shrink-0 text-current" />,
          action:
            path !== RoutePath.BILLING_WALLET
              ? {
                  label: 'Go to Billing',
                  onClick: () => navigate(RoutePath.BILLING_WALLET),
                }
              : undefined,
          isDismissible: false,
        })
      } else if (reason === VERIFY_EMAIL_REASON) {
        addBanner({
          id: SUSPENSION_BANNER_ID,
          variant: 'info',
          title: 'Verification Required',
          description: 'Please verify your email address to access all features.',
          icon: <MailIcon className="h-4 w-4 flex-shrink-0 text-current" />,
          action: {
            label: isCheckingVerification ? 'Checking...' : 'I verified my email',
            onClick: handleVerifyEmailRefresh,
            disabled: isCheckingVerification,
          },
          isDismissible: false,
        })
      }
      return
    }

    if (isCreditsDepletionSuspension(reason)) {
      const suspendedAtDate = suspension.suspendedAt ? new Date(suspension.suspendedAt) : null
      const cleanupDate = suspendedAtDate
        ? addHours(suspendedAtDate, suspension.suspensionCleanupGracePeriodHours ?? 0)
        : null

      const cleanupDatePassed = cleanupDate !== null && cleanupDate <= new Date()

      const cleanupText = cleanupDate
        ? cleanupDatePassed
          ? 'Boxes will be stopped'
          : `Boxes will be stopped ${formatDistanceToNow(cleanupDate, { addSuffix: true })}`
        : 'Boxes will be stopped soon'

      addBanner({
        id: SUSPENSION_BANNER_ID,
        variant: 'error',
        title: 'Credits depleted',
        description: cleanupText,
        action:
          path !== RoutePath.BILLING_WALLET
            ? {
                label: 'Go to Billing',
                onClick: () => navigate(RoutePath.BILLING_WALLET),
              }
            : undefined,
        isDismissible: false,
      })
      return
    }

    const suspendedAtDate = suspension.suspendedAt ? new Date(suspension.suspendedAt) : null
    const cleanupDate = suspendedAtDate
      ? addHours(suspendedAtDate, suspension.suspensionCleanupGracePeriodHours ?? 0)
      : null

    const cleanupDatePassed = cleanupDate !== null && cleanupDate <= new Date()
    const cleanupText = cleanupDate
      ? cleanupDatePassed
        ? 'Boxes will be stopped'
        : `Boxes will be stopped ${formatDistanceToNow(cleanupDate, { addSuffix: true })}`
      : 'Boxes will be stopped soon'

    addBanner({
      id: SUSPENSION_BANNER_ID,
      variant: 'error',
      title: 'Organization suspended',
      description: reason ? `${reason}. ${cleanupText}` : cleanupText,
      isDismissible: false,
    })
  }, [suspension, addBanner, handleVerifyEmailRefresh, isCheckingVerification, removeBanner, navigate, path])
}
