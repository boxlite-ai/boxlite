/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * Commerce gave no usable answer: it is not configured, could not be reached,
 * timed out, rejected the service token, failed, or replied outside its
 * contract. The same request may succeed later.
 */
export class CommerceUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommerceUnavailableError'
  }
}
