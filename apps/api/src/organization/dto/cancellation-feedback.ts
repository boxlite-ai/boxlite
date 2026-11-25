/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { z } from 'zod'

export const cancellationFeedbackInput = z
  .strictObject({
    reasons: z
      .array(
        z.enum([
          'not_tried',
          'no_workload',
          'setup',
          'missing_features',
          'reliability',
          'performance',
          'pricing',
          'limits',
          'alternative',
          'completed',
          'other',
        ]),
      )
      .max(11)
      .transform((values) => [...new Set(values)]),
    intent: z.enum(['evaluate', 'one_off', 'ongoing', 'explore', 'unsure']).nullable().default(null),
    note: z.string().max(1000).trim().default(''),
  })
  .refine((value) => !value.note || value.reasons.includes('other'))
  .refine((value) => value.reasons.length > 0 || value.intent !== null || value.note.length > 0)

export type CancellationFeedbackInput = z.output<typeof cancellationFeedbackInput>
export type CancellationFeedback = CancellationFeedbackInput & { submittedBy: string; submittedAt: string }
