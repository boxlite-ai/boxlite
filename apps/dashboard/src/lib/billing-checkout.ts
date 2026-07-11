/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export function redirectToBillingCheckout(checkoutUrl: string) {
  globalThis.location.assign(checkoutUrl)
}
