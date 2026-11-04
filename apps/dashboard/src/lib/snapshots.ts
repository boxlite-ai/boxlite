/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Box, BoxDesiredState, BoxState } from '@boxlite-ai/api-client'
import { isAxiosError } from 'axios'

export const SNAPSHOT_POLL_INTERVAL = 5000
export const SNAPSHOTS_DISABLED_MESSAGE = 'Snapshots are not enabled in this environment.'

// Mirrors the shared CreateSnapshotDto, including its one-character minimum.
export const isSnapshotNameValid = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)

export const isSnapshotBoxIdle = (box: Box) =>
  box.state === BoxState.STOPPED && box.desiredState === BoxDesiredState.STOPPED

export function snapshotErrorMessage(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined
  if (!isAxiosError(error) && isAxiosError(cause)) return snapshotErrorMessage(cause)
  if (isAxiosError(error)) {
    const reason = error.response?.data?.error?.message ?? error.response?.data?.message
    if (typeof reason === 'string') return reason
  }
  return error instanceof Error ? error.message : 'Request failed. Please try again.'
}
