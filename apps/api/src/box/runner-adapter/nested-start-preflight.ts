/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { RunnerInfo } from './runnerAdapter'

export class NestedStartPreflightError extends Error {
  constructor(runnerId: string, cause?: unknown) {
    super(`Runner ${runnerId} cannot confirm nested virtualization start support`, { cause })
    this.name = NestedStartPreflightError.name
  }
}

/** Only capability reads happen here; a failure cannot have dispatched a start. */
export async function requireNestedStartSupport(runnerId: string, readInfo: () => Promise<RunnerInfo>): Promise<void> {
  let info: RunnerInfo
  try {
    info = await readInfo()
  } catch (cause) {
    throw new NestedStartPreflightError(runnerId, cause)
  }
  if (info.nestedVirtualizationEnabled !== true || info.nestedVirtualizationStartEnabled !== true) {
    throw new NestedStartPreflightError(runnerId)
  }
}
