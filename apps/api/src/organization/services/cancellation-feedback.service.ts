/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common'
import { DataSource } from 'typeorm'
import type { CancellationFeedbackInput } from '../dto/cancellation-feedback'

@Injectable()
export class CancellationFeedbackService {
  constructor(private readonly db: DataSource) {}

  async save(organizationId: string, userId: string, input: CancellationFeedbackInput): Promise<void> {
    const value = { ...input, submittedBy: userId, submittedAt: new Date().toISOString() }
    let rows: { id: string }[]
    try {
      ;[rows] = await this.db.query(
        'UPDATE organization SET "cancellationFeedback" = $2::jsonb, "updatedAt" = now() WHERE id = $1 RETURNING id',
        [organizationId, JSON.stringify(value)],
      )
    } catch {
      // Query errors can include the customer's free-text answers in SQL parameters.
      throw new InternalServerErrorException('Unable to save cancellation feedback. Please retry.')
    }
    if (!rows.length) throw new NotFoundException('Organization not found')
  }
}
