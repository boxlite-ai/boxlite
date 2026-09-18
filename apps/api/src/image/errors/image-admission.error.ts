/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, HttpStatus } from '@nestjs/common'

export const IMAGE_COLD_PULL_RATE_LIMITED_CODE = 'image_cold_pull_rate_limited'

/**
 * Too many image pulls started for this organization inside the current window.
 *
 * This bounds the *rate* at which pulls begin, not how many are in flight:
 * nothing decrements the counter, because the API does not learn that a pull
 * finished until the box reaches STARTED. The window is sized so its budget is
 * roughly what could be downloading at once, and the key's expiry is what
 * clears it. Saying so in the message matters — an operator told "3 concurrent"
 * would go looking for three pulls to watch.
 */
export class ImageColdPullRateLimitedError extends HttpException {
  constructor(
    limit: number,
    windowSeconds: number,
    /** Time left in the current window, which is not its length. */
    readonly retryAfterSeconds: number,
  ) {
    super(
      {
        message: `Too many image pulls started recently: an organization may start at most ${limit} of them per ${windowSeconds}s window. ${retryAfterSeconds}s left in the current one.`,
        code: IMAGE_COLD_PULL_RATE_LIMITED_CODE,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    )
    this.name = 'ImageColdPullRateLimitedError'
  }
}

export const IMAGE_COUNT_LIMIT_CODE = 'image_count_limit_reached'

/**
 * This organization already has as many distinct images as it may keep.
 *
 * The limit counts *kinds* of image, not bytes: under pull-through every
 * runner ends up caching every image an organization uses, so the number of
 * distinct images is what actually grows the fleet's disk. An image already in
 * the catalog is therefore never refused — booting it again costs nothing new.
 */
export class ImageCountLimitReachedError extends HttpException {
  constructor(limit: number) {
    super(
      {
        message: `This organization already holds its limit of ${limit} images. Delete one before using a new image.`,
        code: IMAGE_COUNT_LIMIT_CODE,
      },
      HttpStatus.BAD_REQUEST,
    )
    this.name = 'ImageCountLimitReachedError'
  }
}
