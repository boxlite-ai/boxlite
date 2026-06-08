/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ValidationPipe } from '@nestjs/common'

/**
 * A scoped ValidationPipe that REJECTS request-body fields the DTO does not
 * declare, returning 400 instead of silently dropping them.
 *
 * The global pipe in `main.ts` only runs `transform`, so unknown fields
 * (typos, removed params like `auto_delete_minutes`) pass through unnoticed.
 * Attach this to box/sandbox creation handlers via `@Body(strictBodyValidationPipe)`
 * to make unsupported parameters fail loudly at the boundary.
 *
 * Scoped on purpose — not applied globally — to keep the blast radius to the
 * creation endpoints and avoid 400-ing other endpoints that tolerate extra fields.
 */
export const strictBodyValidationPipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
})
