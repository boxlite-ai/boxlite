/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box, BoxState } from '@boxlite-ai/api-client'
import { isAxiosError } from 'axios'

export const CHECKPOINT_POLL_INTERVAL = 5000
export const CHECKPOINTS_DISABLED_MESSAGE = 'Checkpoints are not enabled in this environment.'

// Matches the checkpoint name contract, including its one-character minimum.
export const isCheckpointNameValid = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)

export const isCheckpointBoxIdle = (box: Box) =>
  (box.state === BoxState.STARTED || box.state === BoxState.STOPPED) &&
  box.state === String(box.desiredState) &&
  !box.volumes?.length &&
  !('pending' in box && box.pending === true) &&
  !('secrets' in box && Array.isArray(box.secrets) && box.secrets.length > 0)

export function checkpointErrorMessage(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined
  if (!isAxiosError(error) && isAxiosError(cause)) return checkpointErrorMessage(cause)
  if (isAxiosError(error)) {
    const reason = error.response?.data?.error?.message ?? error.response?.data?.message
    if (typeof reason === 'string') return reason
  }
  return error instanceof Error ? error.message : 'Request failed. Please try again.'
}
