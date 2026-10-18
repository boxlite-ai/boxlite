/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema } from '@nestjs/swagger'
import { Box } from '../entities/box.entity'
import { NetworkMode } from '../enums/network-mode.enum'
import { networkMode } from '../utils/network-policy.util'

// The network policy as both the control-plane `Box` and the `/v1` box read
// report it, so the two APIs and the generated clients share one schema per
// concept. Field names mirror the `/v1` create request.

@ApiSchema({ name: 'OutboundNetworkSpec' })
export class OutboundNetworkResponseDto {
  @ApiProperty({ description: 'Whether the guest may reach out', enum: NetworkMode, enumName: 'NetworkMode' })
  mode: NetworkMode

  @ApiProperty({
    description: 'Outbound allowlist in force; empty means unrestricted egress',
    type: [String],
    example: ['api.openai.com', '10.0.0.0/8'],
  })
  allow_net: string[]
}

@ApiSchema({ name: 'InboundNetworkSpec' })
export class InboundNetworkResponseDto {
  @ApiProperty({
    description: 'Whether exposed services are reachable through the proxy without sign-in',
    enum: NetworkMode,
    enumName: 'NetworkMode',
  })
  mode: NetworkMode

  @ApiProperty({ description: 'Reserved; no layer enforces an inbound allowlist yet', type: [String], example: [] })
  allow_net: string[]
}

@ApiSchema({ name: 'NetworkInfo' })
export class NetworkInfoResponseDto {
  @ApiProperty({ type: OutboundNetworkResponseDto })
  outbound: OutboundNetworkResponseDto

  @ApiProperty({ type: InboundNetworkResponseDto })
  inbound: InboundNetworkResponseDto

  static fromBox(box: Pick<Box, 'inboundEnabled' | 'outboundEnabled' | 'outboundAllowNet'>): NetworkInfoResponseDto {
    return {
      outbound: { mode: networkMode(box.outboundEnabled), allow_net: box.outboundAllowNet ?? [] },
      inbound: { mode: networkMode(box.inboundEnabled), allow_net: [] },
    }
  }
}
