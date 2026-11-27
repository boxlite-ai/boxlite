/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RequestHandler } from 'express'

export interface RequestTiming {
  requestedAt: Date
  monotonicStart: number
}

const REQUEST_TIMING = Symbol('cloud_request_timing')
type TimedRequest = { [REQUEST_TIMING]?: RequestTiming }

export function requestTiming(request?: object): RequestTiming {
  return (
    (request as TimedRequest | undefined)?.[REQUEST_TIMING] ?? {
      requestedAt: new Date(),
      monotonicStart: performance.now(),
    }
  )
}

/** Capture ingress before parsing and authentication; this performs no I/O. */
export const captureRequestTiming: RequestHandler = (request, _response, next) => {
  const timed = request as TimedRequest
  timed[REQUEST_TIMING] = requestTiming()
  next()
}
