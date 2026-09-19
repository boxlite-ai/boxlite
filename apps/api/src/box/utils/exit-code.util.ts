/*
 * SPDX-License-Identifier: AGPL-3.0
 * Copyright (c) 2026 BoxLite AI
 */

import { BoxState } from '../enums/box-state.enum'

// A recorded exit code describes the run that ended, and nothing else clears
// it: the runner only reports one when a box stops. Any transition that puts
// the box back on its feet begins a new run, so the old code has to go with
// the old one — otherwise a box that is up right now reports the exit code of
// its previous life, which reads exactly like a box that has already died.
const STATES_THAT_BEGIN_A_NEW_RUN: readonly BoxState[] = [
  BoxState.CREATING,
  BoxState.RESTORING,
  BoxState.STARTING,
  BoxState.STARTED,
]

/**
 * Whether entering `state` invalidates a previously recorded main-command exit
 * code. All three writers of box state apply this same rule: the lifecycle
 * actions (`BoxAction.updateBoxState`), the runner-reported updates
 * (`BoxService.updateState`), and the start-job completions
 * (`JobStateHandlerService`, which is where a resumed box becomes STARTED).
 */
export function beginsNewRun(state: BoxState): boolean {
  return STATES_THAT_BEGIN_A_NEW_RUN.includes(state)
}
