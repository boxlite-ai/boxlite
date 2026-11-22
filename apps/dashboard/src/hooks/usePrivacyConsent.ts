/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useEffect } from 'react'
import { useAuth } from 'react-oidc-context'
import { z } from 'zod'
import { toast } from 'sonner'
import { create } from 'zustand'
import { getLocalStorageItem } from '@/lib/local-storage'

const ConsentPreferencesSchema = z.object({
  necessary: z.boolean(),
  analytics: z.boolean(),
  preferences: z.boolean(),
  marketing: z.boolean(),
})

export type ConsentPreferences = z.infer<typeof ConsentPreferencesSchema>

const CONSENT_KEY_PREFIX = 'privacy_consent_'

export function analyticsAllowed(sub: string) {
  const state = usePrivacyConsentStore.getState()
  if (state.currentUserSub !== sub || !state.preferences.analytics) return false
  try {
    return JSON.parse(localStorage.getItem(CONSENT_KEY_PREFIX + sub) ?? 'null')?.analytics === true
  } catch {
    return false
  }
}

const DEFAULT_PREFERENCES: ConsentPreferences = {
  necessary: true,
  analytics: false,
  preferences: false,
  marketing: false,
}

interface PrivacyConsentState {
  currentUserSub: string | null
  hasConsented: boolean
  preferences: ConsentPreferences
  init: (userSub: string) => void
  saveConsent: (newPreferences: ConsentPreferences) => void
}

const usePrivacyConsentStore = create<PrivacyConsentState>()((set, get) => ({
  currentUserSub: null,
  hasConsented: false,
  preferences: DEFAULT_PREFERENCES,

  init: (userSub: string) => {
    set({ currentUserSub: userSub })

    const consentKey = `${CONSENT_KEY_PREFIX}${userSub}`
    try {
      const saved = getLocalStorageItem(consentKey)
      if (saved) {
        const parsedConsent = ConsentPreferencesSchema.parse(JSON.parse(saved))
        set({ preferences: parsedConsent, hasConsented: true })
      } else {
        set({ preferences: DEFAULT_PREFERENCES, hasConsented: false })
      }
    } catch {
      console.error('Error parsing privacy consent')
      set({ preferences: DEFAULT_PREFERENCES, hasConsented: false })
    }
  },

  saveConsent: (newPreferences: ConsentPreferences) => {
    const { currentUserSub } = get()
    if (!currentUserSub) return

    const consentKey = `${CONSENT_KEY_PREFIX}${currentUserSub}`
    try {
      localStorage.setItem(consentKey, JSON.stringify(newPreferences))
      set({ preferences: newPreferences, hasConsented: true })
    } catch {
      if (!newPreferences.analytics) set({ preferences: newPreferences, hasConsented: true })
      toast.error('Failed to save privacy preferences. Please try again.')
    }
  },
}))

export { usePrivacyConsentStore }

export function usePrivacyConsent() {
  const { user } = useAuth()
  const init = usePrivacyConsentStore((state) => state.init)
  const hasConsented = usePrivacyConsentStore((state) => state.hasConsented)
  const preferences = usePrivacyConsentStore((state) => state.preferences)
  const saveConsent = usePrivacyConsentStore((state) => state.saveConsent)

  useEffect(() => {
    if (user?.profile?.sub) {
      const sub = user.profile.sub
      init(sub)
      const refresh = (event: StorageEvent) => {
        if (event.key === null || event.key === CONSENT_KEY_PREFIX + sub) init(sub)
      }
      window.addEventListener('storage', refresh)
      return () => window.removeEventListener('storage', refresh)
    }
  }, [user?.profile?.sub, init])

  return { hasConsented, preferences, saveConsent }
}
