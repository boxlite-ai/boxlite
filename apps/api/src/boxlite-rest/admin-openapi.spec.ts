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
import { AllExceptionsFilter } from '../filters/all-exceptions.filter'

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
  it.each(errors)('$method $path documents the actual $status response', async ({ path, status, schemaRef }) => {
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
    expect(validate({ error: { message: body.error.message } })).toBe(false)
  })
})
