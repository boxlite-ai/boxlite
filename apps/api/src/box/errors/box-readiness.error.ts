/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'

/** A failed runtime transition retains its HTTP contract and a typed telemetry category. */
export class BoxReadinessError extends BadRequestException {}
