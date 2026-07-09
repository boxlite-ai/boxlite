/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import type { NextFunction, Request, Response } from 'express'
import { parseUnprefixedApiHosts, rewriteUnprefixedApiUrlForHost } from '../utils/api-prefix-rewrite'

export function createApiPrefixRewriteMiddleware(allowedHosts: string[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.url = rewriteUnprefixedApiUrlForHost(req.headers.host, req.url, allowedHosts)
    next()
  }
}

export class ApiPrefixRewriteMiddleware {
  private readonly unprefixedApiHosts = parseUnprefixedApiHosts(process.env.UNPREFIXED_API_HOSTS)

  use(req: Request, _res: Response, next: NextFunction) {
    createApiPrefixRewriteMiddleware(this.unprefixedApiHosts)(req, _res, next)
  }
}
