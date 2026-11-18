/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { INestApplication } from '@nestjs/common'
import { raw, Request, Response, NextFunction } from 'express'

export const CI_WEBHOOK_PATH = '/api/v1/ci/github/webhook'

// Register before Nest init so the default JSON parser cannot alter signed bytes.
export function installCiWebhookBodyParser(app: INestApplication): void {
  let receiving = 0
  const parse = raw({ type: 'application/json', limit: '1mb', inflate: false })
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (![CI_WEBHOOK_PATH, CI_WEBHOOK_PATH + '/organization'].includes(req.path) || req.method !== 'POST') return next()
    if (receiving >= 32) return res.status(503).set('Connection', 'close').end()
    if (!req.is('application/json')) return res.status(415).set('Connection', 'close').end()
    receiving++
    let released = false
    const release = () => {
      if (!released) {
        released = true
        receiving--
      }
    }
    const deadline = setTimeout(() => {
      if (!res.headersSent) res.status(503).set('Connection', 'close').end()
      if (!req.complete) req.destroy()
    }, 10_000)
    res.once('close', () => {
      clearTimeout(deadline)
      if (!req.complete) req.destroy()
      release()
    })
    parse(req, res, (error?: { status?: number }) => {
      if (error) {
        res
          .status(error.status === 413 ? 413 : error.status === 415 ? 415 : 400)
          .set('Connection', 'close')
          .end()
        if (!req.complete) req.destroy()
        return
      }
      next()
    })
  })
}
