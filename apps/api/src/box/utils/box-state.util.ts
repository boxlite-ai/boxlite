/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException } from '@nestjs/common'
import { Box } from '../entities/box.entity'
import { BoxDesiredState } from '../enums/box-desired-state.enum'
import { BoxState } from '../enums/box-state.enum'
import { SNAPSHOT_OPERATION_STATES } from '../constants/box.constants'

/**
 * Refuse a change to a box whose disk a snapshot job owns. Deletion is the one
 * change such a box admits, and it does not come through here.
 */
export function assertNoSnapshotOperation(box: Pick<Box, 'id' | 'state'>): void {
  if (SNAPSHOT_OPERATION_STATES.includes(box.state)) {
    throw new ConflictException(`Box ${box.id} is ${box.state} a snapshot; it can only be deleted until that finishes`)
  }
}

/**
 * The state a box is reported in, which is not always the state it is stored
 * in: a transition shows as the transition rather than as the state it is
 * leaving, and a box that has never reported in shows as still being created.
 *
 * Extracted so that the DTO is not the only thing that can answer it. Anything
 * deciding what to say about a box in flight — such as whether it is still
 * waiting on its image — has to agree with what the same response calls its
 * state, and two copies of this switch would eventually disagree.
 */
export function reportedBoxState(box: Pick<Box, 'state' | 'desiredState'>): BoxState {
  switch (box.state) {
    case BoxState.STARTED:
      if (box.desiredState === BoxDesiredState.STOPPED) {
        return BoxState.STOPPING
      }
      if (box.desiredState === BoxDesiredState.DESTROYED) {
        return BoxState.DESTROYING
      }
      break
    case BoxState.STOPPED:
      if (box.desiredState === BoxDesiredState.STARTED) {
        return BoxState.STARTING
      }
      if (box.desiredState === BoxDesiredState.DESTROYED) {
        return BoxState.DESTROYING
      }
      break
    case BoxState.EXPORTING:
    case BoxState.IMPORTING:
      // Deleted mid-snapshot: the deletion is what is happening to it now.
      if (box.desiredState === BoxDesiredState.DESTROYED) {
        return BoxState.DESTROYING
      }
      break
    case BoxState.UNKNOWN:
      // A box the runner has not reported on yet. It is being created, and
      // saying "unknown" would describe this service's knowledge rather than
      // the box.
      if (box.desiredState === BoxDesiredState.STARTED) {
        return BoxState.CREATING
      }
      break
  }
  return box.state
}
