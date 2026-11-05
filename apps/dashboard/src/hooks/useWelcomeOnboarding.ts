/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from 'react-oidc-context'
import { useApi } from './useApi'
import { useOrganizations } from './useOrganizations'
import { useSelectedOrganization } from './useSelectedOrganization'
import { useConfig } from './useConfig'
import { type FirstRunWelcome, type FirstRunUseCase } from '@/lib/first-run'
import { LocalStorageKey } from '@/enums/LocalStorageKey'
import { setLocalStorageItem } from '@/lib/local-storage'

export function useWelcomeOnboarding(initial: FirstRunWelcome) {
  const api = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  const { refreshOrganizations } = useOrganizations()
  const { user } = useAuth()
  const config = useConfig()
  const client = useQueryClient()
  const [welcome, setWelcome] = useState(initial)
  const controller = useRef<AbortController | null>(null)
  const organizationId = selectedOrganization?.id
  useEffect(() => () => controller.current?.abort(), [organizationId])
  const complete = () => {
    if (!organizationId || !user?.profile.sub) return
    const completed = { ...welcome, completedAt: Date.now() }
    setLocalStorageItem(`boxlite:welcome:${user.profile.sub}:${organizationId}`, JSON.stringify(completed))
    setLocalStorageItem(`${LocalStorageKey.SkipOnboardingPrefix}${user.profile.sub}`, 'true')
    setWelcome(completed)
  }
  const action = useMutation({
    mutationFn: async (
      payload: { type: 'organization'; name: string } | { type: 'intent'; useCase: FirstRunUseCase; note: string },
    ) => {
      if (!organizationId) throw new Error('Select an organization and try again.')
      controller.current?.abort()
      const active = new AbortController()
      controller.current = active
      const save = (value: FirstRunWelcome) => {
        active.signal.throwIfAborted()
        setLocalStorageItem(`boxlite:welcome:${user?.profile.sub}:${organizationId}`, JSON.stringify(value))
        setWelcome(value)
      }
      if (payload.type === 'organization') {
        const name = payload.name.trim()
        if (!name || name.length > 60) throw new Error('Enter an organization name of 1–60 characters.')
        await api.organizationsApi.updateOrganizationName(organizationId, { name })
        active.signal.throwIfAborted()
        await refreshOrganizations()
        save({ ...welcome, organizationName: name })
        return
      }
      await api.saveOrganizationOnboarding(organizationId, { useCase: payload.useCase, note: payload.note.trim() })
      active.signal.throwIfAborted()
      client.setQueryData(['organization-onboarding', organizationId], {
        useCase: payload.useCase,
        note: payload.note.trim(),
      })
      save({ ...welcome, useCase: payload.useCase, note: payload.note.trim() })
      if (!config.billingApiUrl) {
        save({ ...welcome, useCase: payload.useCase, note: payload.note.trim(), completedAt: Date.now() })
        setLocalStorageItem(`${LocalStorageKey.SkipOnboardingPrefix}${user?.profile.sub}`, 'true')
        return
      }
    },
  })
  return { welcome, action, complete, billingEnabled: Boolean(config.billingApiUrl) }
}
