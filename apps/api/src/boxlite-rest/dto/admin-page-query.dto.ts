/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'
import { Type } from 'class-transformer'
import { IsInt, IsString, Length, Max, Min, ValidateIf, isUUID } from 'class-validator'
import { cursorFor, cursorValue } from '../../admin/utils/pagination'

type Resource = 'users' | 'invites'

export class AdminPageQuery {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  pageSize = 100

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(1, 2048)
  pageToken?: string

  after(organizationId: string, resource: Resource): string | undefined {
    if (this.pageToken === undefined) return undefined
    try {
      const cursor = JSON.parse(cursorValue(this.pageToken))
      if (
        !Array.isArray(cursor) ||
        cursor.length !== 4 ||
        cursor[0] !== 1 ||
        cursor[1] !== organizationId ||
        cursor[2] !== resource ||
        typeof cursor[3] !== 'string' ||
        !cursor[3] ||
        (resource === 'invites' && !isUUID(cursor[3]))
      ) {
        throw new Error('Invalid page token')
      }
      return cursor[3]
    } catch {
      throw new BadRequestException('Invalid pageToken for this organization and resource')
    }
  }
}

export function adminNextPage<T>(
  rows: T[],
  size: number,
  organizationId: string,
  resource: Resource,
  id: (row: T) => string,
) {
  return rows.length > size
    ? { next_page_token: cursorFor(JSON.stringify([1, organizationId, resource, id(rows[size - 1])])) }
    : {}
}
