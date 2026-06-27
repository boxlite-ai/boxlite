/*
 * Copyright BoxLite AI, 2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { IsInt, IsOptional, IsPositive, IsString, Max, MaxLength } from 'class-validator'

/** Upper bound on a single top-up: $1,000,000. Guards against fat-finger / abuse amounts. */
const MAX_TOP_UP_CENTS = 100_000_000
import { BillingStatus } from '../wallet/wallet-math'
import { WalletView } from '../wallet/wallet.service'

/**
 * Mirrors the dashboard `OrganizationWallet` contract. The first block is the
 * frozen, already-shipped shape; the Phase-2 dual-pool fields are added as
 * OPTIONAL so the existing UI keeps working unchanged.
 */
export class WalletResponseDto {
  @ApiProperty() balanceCents: number
  @ApiProperty() ongoingBalanceCents: number
  @ApiProperty() name: string
  @ApiProperty() creditCardConnected: boolean

  @ApiPropertyOptional() freeBalanceCents?: number
  @ApiPropertyOptional() paidBalanceCents?: number
  @ApiPropertyOptional({ enum: ['trial', 'active', 'low_balance', 'zero_balance', 'suspended', 'closed'] })
  billingStatus?: BillingStatus
  @ApiPropertyOptional() hasFailedOrPendingInvoice?: boolean

  static fromView(view: WalletView, name: string): WalletResponseDto {
    return {
      balanceCents: view.balanceCents,
      ongoingBalanceCents: view.balanceCents, // ongoing-estimate refresh job deferred to M2
      name,
      creditCardConnected: view.creditCardConnected,
      freeBalanceCents: view.freeBalanceCents,
      paidBalanceCents: view.paidBalanceCents,
      billingStatus: view.billingStatus,
      hasFailedOrPendingInvoice: false,
    }
  }
}

export class TopUpRequestDto {
  @ApiProperty({ description: 'Amount to top up, in cents' })
  @IsInt()
  @IsPositive()
  @Max(MAX_TOP_UP_CENTS)
  amountCents: number
}

export class TopUpCheckoutDto {
  @ApiProperty({ description: 'Provider checkout URL to redirect the user to' })
  url: string
}

export class GrantRequestDto {
  @ApiProperty({ description: 'Free credit to grant, in cents' })
  @IsInt()
  @IsPositive()
  amountCents: number

  @ApiProperty()
  @IsString()
  @MaxLength(200)
  reason: string

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string
}

export class WalletBalancesDto {
  @ApiProperty() balanceCents: number
  @ApiProperty() freeBalanceCents: number
  @ApiProperty() paidBalanceCents: number
}
