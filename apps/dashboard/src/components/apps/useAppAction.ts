/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useAppMutation } from '@/hooks/mutations/useAppMutations'
import type { AppActionInput, AppDetail } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { useState } from 'react'
import { toast } from 'sonner'

/**
 * Runs one of the App screens' small operations: the control that started it
 * shows a spinner (by key) until the control plane answers, then a toast says
 * what happened. The success text may use the returned app (e.g. to name the
 * deployment a variable change started).
 */
export function useAppAction(appId: string) {
  const mutation = useAppMutation()
  const [pending, setPending] = useState<string | null>(null)
  const run = async (
    action: AppActionInput,
    success: string | ((app: AppDetail | null) => string),
    options: { key?: string } = {},
  ): Promise<boolean> => {
    const key = options.key ?? action.type
    setPending(key)
    try {
      const app = await mutation.mutateAsync({ kind: 'action', appId, action })
      toast.success(typeof success === 'function' ? success(app) : success)
      return true
    } catch (error) {
      handleApiError(error, 'That did not work')
      return false
    } finally {
      setPending(null)
    }
  }
  return { run, pending }
}
