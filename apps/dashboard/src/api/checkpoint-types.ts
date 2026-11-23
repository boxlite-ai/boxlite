// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

export const CheckpointStatus = {
  CREATING: 'creating',
  READY: 'ready',
  FAILED: 'failed',
  DELETING: 'deleting',
} as const

export interface Checkpoint {
  id: string
  name: string
  source_box_id: string
  created_at: string
  size_bytes: number
  state: 'creating' | 'ready' | 'failed' | 'deleting'
  error_reason?: string
}

export interface CheckpointPage {
  checkpoints: Checkpoint[]
  next_page_token?: string
}
