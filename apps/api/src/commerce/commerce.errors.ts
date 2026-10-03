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

/**
 * Commerce refused a referral event because another organization already
 * referred the same invitee. Sending it again cannot succeed.
 */
export class CommerceConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommerceConflictError'
  }
}
