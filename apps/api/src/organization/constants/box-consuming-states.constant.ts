/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BoxState } from '../../box/enums/box-state.enum'

/**
 * States in which a box occupies compute (cpu / memory / gpu) and a running slot.
 * These are the "running-ish" states — anything on its way up, up, or on its way
 * down still pins the resources on a runner.
 */
export const BOX_STATES_CONSUMING_COMPUTE: BoxState[] = [
  BoxState.CREATING,
  BoxState.RESTORING,
  BoxState.STARTING,
  BoxState.STARTED,
  BoxState.STOPPING,
  BoxState.UNKNOWN,
]

/**
 * States in which a box occupies disk. Broader than compute: a STOPPED (or
 * ARCHIVING) box frees its cpu/memory and its running slot but still holds its
 * disk image, so disk keeps counting.
 */
export const BOX_STATES_CONSUMING_DISK: BoxState[] = [
  ...BOX_STATES_CONSUMING_COMPUTE,
  BoxState.STOPPED,
  BoxState.ARCHIVING,
]
