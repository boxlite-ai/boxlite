/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OnboardingGuideDialog } from '@/components/OnboardingGuideDialog'
import {
  ONBOARDING_ENTRY_HIGHLIGHT_EVENT,
  ONBOARDING_OPEN_EVENT,
  ONBOARDING_PROGRESS_EVENT,
  mergeOnboardingProgress,
  readOnboardingProgress,
  type OnboardingProgress,
} from '@/lib/onboarding-progress'
import { useCallback, useEffect, useState } from 'react'
import { useAuth } from 'react-oidc-context'

// Single, app-global host for the onboarding guide dialog. Rendered once in the
// dashboard shell so the "Guide" button (which dispatches ONBOARDING_OPEN_EVENT)
// opens a dialog from ANY page without navigating away. Replaces the per-page
// redirect to /dashboard/boxes?onboarding=1. First-visit auto-open and the
// ?onboarding=1 URL param are still handled by the box pages themselves.
export function OnboardingDialogHost() {
  const { user } = useAuth()
  const userId = user?.profile.sub
  const [open, setOpen] = useState(false)
  const [progress, setProgress] = useState<OnboardingProgress>(() => readOnboardingProgress(userId))

  useEffect(() => {
    setProgress(readOnboardingProgress(userId))
  }, [userId])

  useEffect(() => {
    const handleProgress = (event: Event) => {
      const next = (event as CustomEvent<OnboardingProgress>).detail
      setProgress(next ?? readOnboardingProgress(userId))
    }
    window.addEventListener(ONBOARDING_PROGRESS_EVENT, handleProgress)
    return () => window.removeEventListener(ONBOARDING_PROGRESS_EVENT, handleProgress)
  }, [userId])

  useEffect(() => {
    const handleOpen = (event: Event) => {
      event.preventDefault()
      setOpen(true)
    }
    window.addEventListener(ONBOARDING_OPEN_EVENT, handleOpen)
    return () => window.removeEventListener(ONBOARDING_OPEN_EVENT, handleOpen)
  }, [])

  const handleProgressChange = useCallback(
    (update: OnboardingProgress) => {
      setProgress(mergeOnboardingProgress(userId, update))
    },
    [userId],
  )

  // Closing a dialog the user opened from the nav means "I am done looking",
  // not "never offer onboarding again" — so this path no longer writes
  // SkipOnboarding. Dismissing the auto-open still does, from Boxes.tsx's own
  // close handler; that and BoxDetails' "I already have a box" are the two
  // places where the user actually said they were done being offered it.
  const handleClose = useCallback(() => {
    setOpen(false)
    window.setTimeout(() => {
      window.dispatchEvent(new Event(ONBOARDING_ENTRY_HIGHLIGHT_EVENT))
    }, 220)
  }, [])

  return (
    <OnboardingGuideDialog
      open={open}
      onOpenChange={(isOpen) => (isOpen ? setOpen(true) : handleClose())}
      onProgressChange={handleProgressChange}
      progress={progress}
    />
  )
}
