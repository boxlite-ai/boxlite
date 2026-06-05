/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

export class RuntimeArtifactStateError extends Error {
  constructor(public readonly errorReason: string) {
    super(errorReason)
    this.name = 'RuntimeArtifactStateError'
  }
}
