/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { useAppMutation } from '@/hooks/mutations/useAppMutations'
import type { AppActionInput } from '@/lib/apps/types'
import { handleApiError } from '@/lib/error-handling'
import { useState } from 'react'
import { toast } from 'sonner'

/**
 * Runs one of the App screens' small operations: the control that started it
 * shows a spinner (by key) until the result is back, then a toast says what
 * happened. An optional undo action is offered for reversible changes.
 */
export function useAppAction(appId: string) {
  const mutation = useAppMutation()
  const [pending, setPending] = useState<string | null>(null)
  const run = async (
    action: AppActionInput,
    success: string,
    options: { key?: string; undo?: AppActionInput } = {},
  ): Promise<boolean> => {
    const key = options.key ?? action.type
    setPending(key)
    try {
      await mutation.mutateAsync({ kind: 'action', appId, action })
      const undo = options.undo
      toast.success(
        success,
        undo
          ? {
              action: {
                label: 'Undo',
                onClick: () => void mutation.mutateAsync({ kind: 'action', appId, action: undo }),
              },
            }
          : undefined,
      )
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
