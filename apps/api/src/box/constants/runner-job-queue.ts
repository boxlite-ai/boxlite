// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

export function runnerJobQueueKey(runnerId: string): string {
  return `runner:jobs:${runnerId}`
}
