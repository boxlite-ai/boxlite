/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import * as z from 'zod'
import { NetworkMode } from '../../../box/enums/network-mode.enum'
import type { BoxResponseDto } from '../../../boxlite-rest/dto/box-response.dto'
import { organizationInput } from '../shared/mcp-tool'

export const boxSelectorSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.includes('\0'), { message: 'Box selector must not contain NUL' })
export const boxToolInput = z.strictObject({ ...organizationInput, box_id: boxSelectorSchema })

export const listBoxesInputSchema = z.strictObject({
  organization_id: z.uuid().describe('ID of the organization whose boxes to list'),
})

const networkDirectionSchema = z.object({
  mode: z.enum(NetworkMode),
  allow_net: z.array(z.string()),
})

// Keep the advertised contract aligned with the existing REST response mapper.
export const boxResponseSchema = z.object({
  box_id: z.string(),
  name: z.string().optional(),
  status: z.enum(['configured', 'running', 'stopping', 'stopped', 'unknown']),
  created_at: z.string(),
  updated_at: z.string(),
  last_activity_at: z.string().optional(),
  pid: z.number().optional(),
  image: z.string(),
  cpus: z.number(),
  memory_mib: z.number(),
  labels: z.record(z.string(), z.string()),
  auto_stop: z.number(),
  auto_delete: z.number(),
  auto_resume: z.boolean(),
  exit_code: z.number().optional(),
  network: z
    .object({
      outbound: networkDirectionSchema,
      inbound: networkDirectionSchema,
    })
    .optional(),
}) satisfies z.ZodType<BoxResponseDto>

export const listBoxesOutputSchema = z.array(boxResponseSchema)
