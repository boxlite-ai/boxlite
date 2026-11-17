/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { Type } from 'class-transformer'
import { IsBoolean, IsIn, IsInt, IsUUID, Matches, Max, Min, ValidateIf } from 'class-validator'

export class CiAdminPage {
  @ValidateIf((_o, value) => value !== undefined)
  @IsUUID()
  cursor?: string
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25
}
export class CiAdminLookup extends CiAdminPage {
  @IsIn(['User', 'Organization'])
  account_type: 'User' | 'Organization'
  @ValidateIf((_o, value) => value !== undefined)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/)
  github_account?: string
  @ValidateIf((_o, value) => value !== undefined)
  @Matches(/^[1-9][0-9]{0,15}$/)
  github_account_id?: string
}
export class CiAdminCreate {
  @IsIn(['User', 'Organization'])
  account_type: 'User' | 'Organization'
  @Matches(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/)
  github_account: string
  @IsBoolean()
  allow_private_repositories: boolean
  @IsBoolean()
  force = false
  @ValidateIf((_o, value) => value !== undefined)
  @IsUUID()
  expected_binding_id?: string
  @ValidateIf((_o, value) => value !== undefined)
  @Matches(/^[1-9][0-9]{0,17}$/)
  expected_generation?: string
}
export class CiAdminVersion {
  @Matches(/^[1-9][0-9]{0,17}$/)
  expected_generation: string
}
export class CiAdminUpdate extends CiAdminVersion {
  @IsBoolean()
  allow_private_repositories: boolean
}
