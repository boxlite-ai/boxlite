/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ArgumentsHost, HttpException, UnauthorizedException } from '@nestjs/common'
import Ajv2020 from 'ajv/dist/2020'
import addFormats from 'ajv-formats'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { AllExceptionsFilter } from '../filters/all-exceptions.filter'
import { parseProxyCredentialWrite } from '../box/outbound-proxy/proxy-registry-body'

const adminId = 'https://contract.test/admin.openapi.yaml'
const admin = parse(readFileSync(resolve(__dirname, '../../../../openapi/admin.openapi.yaml'), 'utf8'))
const box = parse(readFileSync(resolve(__dirname, '../../../../openapi/box.openapi.yaml'), 'utf8'))
const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }))
ajv.addSchema({ components: admin.components, paths: admin.paths }, adminId)
ajv.addSchema({ components: box.components }, new URL('./box.openapi.yaml', adminId).href)

type Operation = { responses?: Record<string, { $ref?: string }> }
const errors = Object.entries(admin.paths).flatMap(([path, item]) =>
  Object.entries(item as Record<string, Operation>).flatMap(([method, operation]) =>
    Object.entries(operation.responses ?? {})
      .filter(([status]) => /^4\d\d$/.test(status))
      .map(([status, response]) => {
        const pointer = path.replace(/~/g, '~0').replace(/\//g, '~1')
        const responseRef = response.$ref
          ? new URL(response.$ref, adminId).href
          : `${adminId}#/paths/${pointer}/${method}/responses/${status}`
        return { path, method, status: Number(status), schemaRef: `${responseRef}/content/application~1json/schema` }
      }),
  ),
)

describe('Admin API error contract', () => {
  it.each(errors.filter(({ status }) => status !== 413 && status !== 415))(
    '$method $path documents the controller $status response',
    async ({ path, status, schemaRef }) => {
      const validate = ajv.getSchema(schemaRef)
      if (!validate) throw new Error(`Missing Admin API error schema: ${schemaRef}`)

      const json = jest.fn()
      const sendStatus = jest.fn().mockReturnValue({ json })
      const filter = new AllExceptionsFilter({ incrementFailedAuth: jest.fn().mockResolvedValue(undefined) } as never)
      const url = `/api/v1${path.replace('{prefix}', 'org-1')}`
      const host = {
        switchToHttp: () => ({
          getResponse: () => ({ status: sendStatus, getHeader: jest.fn() }),
          getRequest: () => ({ path: url, url }),
        }),
      } as ArgumentsHost
      const exception =
        status === 401
          ? new UnauthorizedException('Invalid credentials')
          : new HttpException(
              { message: ['Request refused', 'Check organization access'], code: 'request_refused' },
              status,
            )

      await filter.catch(exception, host)

      expect(sendStatus).toHaveBeenCalledWith(status)
      expect(json).toHaveBeenCalledTimes(1)
      const body = json.mock.calls[0][0]
      expect(validate(body)).toBe(true)
      expect(validate({ message: body.message })).toBe(false)
    },
  )

  it.each(
    errors.filter(
      ({ path, method, status }) =>
        path.includes('/proxies') && (method === 'post' || method === 'patch') && [400, 413, 415].includes(status),
    ),
  )('$method $path documents the parser $status response', async ({ path, method, status, schemaRef }) => {
    const validate = ajv.getSchema(schemaRef)
    if (!validate) throw new Error(`Missing parser error schema: ${schemaRef}`)
    const url = `/api/v1${path.replace('{prefix}', 'org-1').replace('{name}', 'proxy-1')}`
    const app = express()
    const handler: express.RequestHandler = (_req, res) => {
      res.sendStatus(204)
    }
    if (method === 'post') app.post(url, parseProxyCredentialWrite, handler)
    else app.patch(url, parseProxyCredentialWrite, handler)
    const listener = app.listen(0, '127.0.0.1')
    try {
      if (!listener.listening)
        await new Promise<void>((resolve, reject) => listener.once('listening', resolve).once('error', reject))
      const { port } = listener.address() as AddressInfo
      const response = await fetch(`http://127.0.0.1:${port}${url}`, {
        method: method.toUpperCase(),
        headers: { 'content-type': status === 415 ? 'text/plain' : 'application/json' },
        body: status === 413 ? JSON.stringify({ url: 'x'.repeat(103_000) }) : '{',
      })
      expect(response.status).toBe(status)
      const body = await response.json()
      expect(body).toEqual({ statusCode: status, message: expect.any(String) })
      expect(validate(body)).toBe(true)
    } finally {
      await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())))
    }
  })
})
