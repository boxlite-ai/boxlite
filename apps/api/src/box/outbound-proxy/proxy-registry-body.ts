/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { json, RequestHandler } from 'express'

export function isProxyCredentialWrite(method: string, path: string): boolean {
  const verb = method.toUpperCase()
  return (
    (verb === 'POST' && /^\/api\/v1(?:\/[^/]+)?\/proxies\/?$/i.test(path)) ||
    (verb === 'PATCH' && /^\/api\/v1(?:\/[^/]+)?\/proxies\/[^/]+\/?$/i.test(path))
  )
}

const proxyJson = json({ limit: '100kb' })
const failures: Record<number, string> = {
  400: 'Invalid JSON in request body',
  413: 'Proxy request body too large',
  415: 'Unsupported proxy request content type or encoding',
}

export const parseProxyCredentialWrite: RequestHandler = (req, res, next) => {
  if (!req.is('application/json')) {
    res.status(415).json({ statusCode: 415, message: failures[415] })
    return
  }
  proxyJson(req, res, (error?: unknown) => {
    if (!error) return next()
    const status = (error as { status?: number }).status
    const safeStatus = status === 413 || status === 415 ? status : 400
    res.status(safeStatus).json({ statusCode: safeStatus, message: failures[safeStatus] })
  })
}
