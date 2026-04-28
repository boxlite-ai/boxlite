/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Action, toast } from 'sonner'
import { BoxliteError } from '@/api/errors'

interface HandleApiErrorOptions {
  action?: React.ReactNode | Action
  toastId?: string
}

export function handleApiError(error: unknown, message: string, options?: HandleApiErrorOptions) {
  const isBoxliteError = error instanceof BoxliteError

  toast.error(message, {
    ...(options?.toastId ? { id: options.toastId } : {}),
    description: isBoxliteError ? error.message : 'Please try again or check the console for more details',
    action: options?.action,
  })

  if (!isBoxliteError) {
    console.error(message, error)
  }
}
