/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { Box } from '../../box/entities/box.entity'
import { BoxDesiredState } from '../../box/enums/box-desired-state.enum'
import { BoxState } from '../../box/enums/box-state.enum'
import { BOX_WARM_POOL_UNASSIGNED_ORGANIZATION } from '../../box/constants/box.constants'

export enum MeteringMode {
  FULL = 'full',
  DISK_ONLY = 'disk_only',
  NONE = 'none',
  PRESERVE = 'preserve',
}

type MeteringBox = Pick<Box, 'organizationId' | 'state' | 'desiredState' | 'runtimeUnavailable'>

const NON_BILLABLE_STATES = new Set([BoxState.ERROR, BoxState.ARCHIVED, BoxState.DESTROYING, BoxState.DESTROYED])

@Injectable()
export class MeteringPolicy {
  resolve(box: MeteringBox): MeteringMode {
    if (box.organizationId === BOX_WARM_POOL_UNASSIGNED_ORGANIZATION) {
      return MeteringMode.NONE
    }

    if (box.state === BoxState.ERROR && box.runtimeUnavailable && box.desiredState === BoxDesiredState.STARTED) {
      return MeteringMode.DISK_ONLY
    }

    if (box.state === BoxState.ERROR && box.desiredState === BoxDesiredState.STOPPED) {
      return MeteringMode.DISK_ONLY
    }

    if (box.desiredState === BoxDesiredState.DESTROYED || NON_BILLABLE_STATES.has(box.state)) {
      return MeteringMode.NONE
    }

    if (
      box.desiredState === BoxDesiredState.STOPPED ||
      box.state === BoxState.STOPPING ||
      box.state === BoxState.STOPPED
    ) {
      return MeteringMode.DISK_ONLY
    }

    if (box.state === BoxState.STARTED && box.desiredState === BoxDesiredState.STARTED) {
      return MeteringMode.FULL
    }

    return MeteringMode.PRESERVE
  }
}
