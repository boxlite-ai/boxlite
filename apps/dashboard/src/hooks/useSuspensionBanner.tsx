/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useBanner } from '@/components/Banner'
import { RoutePath } from '@/enums/RoutePath'
import { Organization } from '@boxlite-ai/api-client'
import { addHours, formatDistanceToNow } from 'date-fns'
import { CreditCardIcon, MailIcon } from '@/components/ui/icon'
import { useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

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
  'suspended' | 'suspensionReason' | 'suspendedAt' | 'suspensionCleanupAt' | 'suspensionCleanupGracePeriodHours'
>

function getCleanupDate(suspension: Suspension) {
  if (suspension.suspensionCleanupAt) {
    return new Date(suspension.suspensionCleanupAt)
  }

  return suspension.suspendedAt
    ? addHours(new Date(suspension.suspendedAt), suspension.suspensionCleanupGracePeriodHours ?? 0)
    : null
}

function getCleanupText(suspension: Suspension) {
  const cleanupDate = getCleanupDate(suspension)
  if (!cleanupDate) return 'Boxes will be stopped soon'

  return cleanupDate <= new Date()
    ? 'Boxes will be stopped'
    : `Boxes will be stopped ${formatDistanceToNow(cleanupDate, { addSuffix: true })}`
}

export function useSuspensionBanner(suspension?: Suspension | null) {
  const { addBanner, removeBanner } = useBanner()
  const navigate = useNavigate()
  const location = useLocation()
  const path = location?.pathname
  const previousSuspendedRef = useRef<boolean | undefined>(undefined)

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
            path !== RoutePath.BILLING
              ? {
                  label: 'Go to Billing',
                  onClick: () => navigate(RoutePath.BILLING),
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
          isDismissible: false,
        })
      }
      return
    }

    if (isCreditsDepletionSuspension(reason)) {
      addBanner({
        id: SUSPENSION_BANNER_ID,
        variant: 'error',
        title: 'Credits depleted',
        description: getCleanupText(suspension),
        action:
          path !== RoutePath.BILLING
            ? {
                label: 'Go to Billing',
                onClick: () => navigate(RoutePath.BILLING),
              }
            : undefined,
        isDismissible: false,
      })
      return
    }

    addBanner({
      id: SUSPENSION_BANNER_ID,
      variant: 'error',
      title: 'Organization suspended',
      description: `${reason}. ${getCleanupText(suspension)}`,
      isDismissible: false,
    })
  }, [suspension, addBanner, removeBanner, navigate, path])
}
