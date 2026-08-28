/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

export class BoxInventoryLimitExceededError extends Error {
  constructor(
    public readonly current: number,
    public readonly limit: number,
  ) {
    super(`Box inventory count ${current} reaches or exceeds limit ${limit}`)
    this.name = 'BoxInventoryLimitExceededError'
  }
}
