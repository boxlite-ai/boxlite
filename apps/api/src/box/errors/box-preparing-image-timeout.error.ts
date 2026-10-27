/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RequestTimeoutException } from '@nestjs/common'
import { BoxProgressDto } from '../dto/box.dto'

/**
 * The wait for a box gave up while its image was still being pulled.
 *
 * Still a timeout and still the same status: the caller asked for a started
 * box and did not get one, and nothing about that changed. What it adds is
 * why, and how long to leave it — a first pull runs for longer than a request
 * should be held open, so a caller told only "timed out" cannot tell a slow
 * start from a stuck one, and retrying immediately is its worst option.
 *
 * `progress` travels in the body in the shape `BoxDto.progress` already
 * publishes, so a caller that understands one understands the other.
 * `retryAfterSeconds` is what the exception filter turns into `Retry-After`.
 */
export class BoxPreparingImageTimeoutError extends RequestTimeoutException {
  /** Whole seconds, rounded up and never zero: `Retry-After` has no finer unit. */
  readonly retryAfterSeconds: number

  constructor(message: string, progress: BoxProgressDto) {
    super({ message, progress })
    this.retryAfterSeconds = Math.max(1, Math.ceil(progress.retryAfterMs / 1000))
    this.name = 'BoxPreparingImageTimeoutError'
  }
}
