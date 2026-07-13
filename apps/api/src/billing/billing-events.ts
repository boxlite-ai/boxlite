/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

export const BillingEvents = {
  WALLET_BALANCE_CHANGED: 'billing.wallet.balance-changed',
} as const

export class WalletBalanceChangedEvent {
  constructor(public readonly organizationId: string) {}
}
