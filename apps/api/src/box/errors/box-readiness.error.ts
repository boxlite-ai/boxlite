/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestError } from '../../exceptions/bad-request.exception'

/** A failed runtime transition retains its HTTP contract and a typed telemetry category. */
export class BoxReadinessError extends BadRequestError {}
