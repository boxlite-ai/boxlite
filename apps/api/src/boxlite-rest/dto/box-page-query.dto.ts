/* Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */
import { BadRequestException } from '@nestjs/common'
import { Type } from 'class-transformer'
import { IsIn, IsInt, IsString, Length, Max, Min, ValidateIf } from 'class-validator'
import { cursorFor, cursorValue } from '../../admin/utils/pagination'
import { BOX_PUBLIC_STATUSES, BoxPublicStatus } from '../../box/utils/box-public-status'
import { BOX_ID_REGEX } from '../../box/utils/box-id.util'

export class BoxPageQuery {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  pageSize = 100

  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(BOX_PUBLIC_STATUSES)
  status?: BoxPublicStatus

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @Length(1, 2048)
  pageToken?: string

  /** Validate the saved position against the caller's organization and unchanged status selection. */
  after(organizationId: string): string | undefined {
    if (this.pageToken === undefined) return undefined
    try {
      const cursor = JSON.parse(cursorValue(this.pageToken))
      if (
        !Array.isArray(cursor) ||
        cursor.length !== 5 ||
        cursor[0] !== 1 ||
        cursor[1] !== 'boxes' ||
        cursor[2] !== organizationId ||
        cursor[3] !== (this.status ?? null) ||
        typeof cursor[4] !== 'string' ||
        !BOX_ID_REGEX.test(cursor[4])
      ) {
        throw new Error('Invalid page token')
      }
      return cursor[4]
    } catch {
      throw new BadRequestException('Invalid pageToken for this organization and status')
    }
  }

  /** Encode a position only; each subsequent query independently reapplies authorization. */
  next(organizationId: string, lastId: string): string {
    return cursorFor(JSON.stringify([1, 'boxes', organizationId, this.status ?? null, lastId]))
  }
}
