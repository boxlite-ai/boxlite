/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { EntityManager } from 'typeorm'

export class OrganizationUserRemovedEvent {
  private readonly afterCommitTasks: Array<() => Promise<void>> = []

  constructor(
    public readonly entityManager: EntityManager,
    public readonly organizationId: string,
    public readonly userId: string,
  ) {}

  /**
   * Defers work until the removal commits. Cache invalidation belongs here: cleared
   * inside the transaction, a cache can be refilled by a concurrent request that
   * still reads the uncommitted rows.
   */
  afterCommit(task: () => Promise<void>): void {
    this.afterCommitTasks.push(task)
  }

  async runAfterCommitTasks(): Promise<void> {
    await Promise.all(this.afterCommitTasks.map((task) => task()))
  }
}
