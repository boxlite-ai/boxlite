/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema } from '@nestjs/swagger'
import { IsNotEmpty, IsString } from 'class-validator'

@ApiSchema({ name: 'CreateAttachTicket' })
export class CreateAttachTicketDto {
  @ApiProperty({ description: 'The execution the ticket may attach to' })
  @IsString()
  @IsNotEmpty()
  executionId: string
}

@ApiSchema({ name: 'AttachTicket' })
export class AttachTicketDto {
  @ApiProperty({ description: 'Single-use credential for the attach WebSocket, sent as its `ticket` query parameter' })
  ticket: string

  @ApiProperty({ description: 'Seconds until the ticket expires', example: 30 })
  expiresIn: number
}
