/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxState } from '@boxlite-ai/api-client'
import { CheckCircle, Circle, AlertTriangle, Timer } from 'lucide-react'
import { FacetedFilterOption } from './types'

const STATE_LABEL_MAPPING: Record<BoxState, string> = {
  [BoxState.STARTED]: 'Running',
  [BoxState.STOPPED]: 'Stopped',
  [BoxState.ERROR]: 'Error',
  [BoxState.BUILD_FAILED]: 'Build Failed',
  [BoxState.BUILDING_ARTIFACT]: 'Preparing runtime',
  [BoxState.PENDING_BUILD]: 'Pending Build',
  [BoxState.RESTORING]: 'Restoring',
  [BoxState.ARCHIVED]: 'Archived',
  [BoxState.CREATING]: 'Creating',
  [BoxState.STARTING]: 'Starting',
  [BoxState.STOPPING]: 'Stopping',
  [BoxState.DESTROYING]: 'Deleting',
  [BoxState.DESTROYED]: 'Deleted',
  [BoxState.UNKNOWN]: 'Unknown',
  [BoxState.ARCHIVING]: 'Archiving',
  [BoxState.RESIZING]: 'Resizing',
}

export const STATUSES: FacetedFilterOption[] = [
  {
    label: getStateLabel(BoxState.STARTED),
    value: BoxState.STARTED,
    icon: CheckCircle,
  },
  { label: getStateLabel(BoxState.STOPPED), value: BoxState.STOPPED, icon: Circle },
  { label: getStateLabel(BoxState.ERROR), value: BoxState.ERROR, icon: AlertTriangle },
  { label: getStateLabel(BoxState.BUILD_FAILED), value: BoxState.BUILD_FAILED, icon: AlertTriangle },
  { label: getStateLabel(BoxState.STARTING), value: BoxState.STARTING, icon: Timer },
  { label: getStateLabel(BoxState.STOPPING), value: BoxState.STOPPING, icon: Timer },
  { label: getStateLabel(BoxState.DESTROYING), value: BoxState.DESTROYING, icon: Timer },
]

export function getStateLabel(state?: BoxState): string {
  if (!state) {
    return 'Unknown'
  }
  return STATE_LABEL_MAPPING[state]
}
