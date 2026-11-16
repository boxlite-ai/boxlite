/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import React, { Suspense, useEffect, useMemo, useState } from 'react'
import { Outlet, useLocation } from 'react-router-dom'
import { LogoText } from '@/assets/Logo'
import { RoutePath } from '@/enums/RoutePath'
import { Skeleton } from '@/components/ui/skeleton'

import { AnnouncementBanner } from '@/components/AnnouncementBanner'
import { OnboardingDialogHost } from '@/components/OnboardingDialogHost'
import { Sidebar } from '@/components/Sidebar'
import { Toaster } from '@/components/ui/sonner'
import { VerifyEmailDialog } from '@/components/VerifyEmailDialog'
import { LocalStorageKey } from '@/enums/LocalStorageKey'
import { useOwnerWalletQuery } from '@/hooks/queries/billingQueries'
import { useConfig } from '@/hooks/useConfig'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { useSuspensionBanner } from '@/hooks/useSuspensionBanner'
import { cn } from '@/lib/utils'

/** Keeps navigation mounted across lazy routes and owns header/banner viewport offsets. */
const Dashboard: React.FC = () => {
  const { pathname } = useLocation()
  const isWelcome = pathname === RoutePath.WELCOME
  const { selectedOrganization } = useSelectedOrganization()
  const [showVerifyEmailDialog, setShowVerifyEmailDialog] = useState(false)
  const config = useConfig()
  useOwnerWalletQuery() // prefetch wallet

  useSuspensionBanner(selectedOrganization)

  useEffect(() => {
    if (
      selectedOrganization?.suspended &&
      selectedOrganization.suspensionReason === 'Please verify your email address'
    ) {
      setShowVerifyEmailDialog(true)
    }
  }, [selectedOrganization])

  const [bannerText, bannerLearnMoreUrl] = useMemo(() => {
    if (!config.announcements || Object.entries(config.announcements).length === 0) {
      return [null, null]
    }

    return [Object.values(config.announcements)[0].text, Object.values(config.announcements)[0].learnMoreUrl]
  }, [config.announcements])
  const [isBannerVisible, setIsBannerVisible] = useState(false)

  useEffect(() => {
    if (!bannerText) {
      setIsBannerVisible(false)
      return
    }

    // Check if this announcement has been dismissed
    const dismissedBanners = JSON.parse(localStorage.getItem(LocalStorageKey.AnnouncementBannerDismissed) || '[]')
    const isDismissed = dismissedBanners.includes(bannerText)

    setIsBannerVisible(!isDismissed)
  }, [bannerText])

  const handleDismissBanner = () => {
    // Add this announcement to the dismissed list
    const dismissedBanners = JSON.parse(localStorage.getItem(LocalStorageKey.AnnouncementBannerDismissed) || '[]')
    localStorage.setItem(LocalStorageKey.AnnouncementBannerDismissed, JSON.stringify([...dismissedBanners, bannerText]))

    setIsBannerVisible(false)
  }

  const content = (
    <div className="min-h-0 min-w-0 flex-1">
      <div className="w-full min-h-[var(--app-content-height,calc(100svh_-_60px))] overscroll-none">
        {/* Lazy route components (Admin/Billing/Settings/box-details) suspend
                here so only the content area shows a fallback — the sidebar/shell
                stays mounted across navigation. */}
        <Suspense
          fallback={
            <div className="space-y-3 p-4 sm:p-5">
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-32 w-full" />
            </div>
          }
        >
          <Outlet />
        </Suspense>
      </div>
    </div>
  )

  return (
    <div
      className={cn(
        'relative w-full [--app-banner-height:0px] [--app-header-height:60px] [--app-content-height:calc(100svh_-_var(--app-header-height)_-_var(--app-banner-height))]',
        '[--app-header-height:64px] md:[--app-header-height:64px]',
        isBannerVisible && 'pt-16 [--app-banner-height:4rem] md:pt-12 md:[--app-banner-height:3rem]',
      )}
    >
      {isBannerVisible && bannerText && (
        <AnnouncementBanner text={bannerText} onDismiss={handleDismissBanner} learnMoreUrl={bannerLearnMoreUrl} />
      )}
      <div className="flex min-h-[calc(100svh_-_var(--app-banner-height))] flex-col">
        <>
          {isWelcome ? (
            <>
              <header className="flex h-[60px] items-center justify-between border-b border-border px-6 sm:px-10">
                <LogoText className="h-[40px] w-auto" />
                <span className="font-sans text-label text-muted-foreground">GET STARTED WITH BOXLITE</span>
              </header>
              {content}
            </>
          ) : (
            <Sidebar isBannerVisible={isBannerVisible} version={config.version}>
              {content}
            </Sidebar>
          )}
        </>
        {!isWelcome && <OnboardingDialogHost />}
        <Toaster />
        <VerifyEmailDialog open={showVerifyEmailDialog} onOpenChange={setShowVerifyEmailDialog} />
      </div>
    </div>
  )
}

export default Dashboard
