/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { Type } from 'class-transformer'
import { IsBoolean, IsIn, IsInt, IsUUID, Matches, Max, Min, ValidateIf } from 'class-validator'
import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'

@ApiSchema({ name: 'AdminCiConnectionPageQuery' })
export class CiAdminPage {
  @ApiPropertyOptional({ type: String, format: 'uuid', description: 'Last binding ID from the previous page.' })
  @ValidateIf((_o, value) => value !== undefined)
  @IsUUID()
  cursor?: string
  @ApiPropertyOptional({ type: 'integer', default: 25, minimum: 1, maximum: 100 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25
}
@ApiSchema({ name: 'AdminCiConnectionLookup' })
export class CiAdminLookup extends CiAdminPage {
  @ApiProperty({ enum: ['User', 'Organization'] })
  @IsIn(['User', 'Organization'])
  account_type: 'User' | 'Organization'
  @ApiPropertyOptional({
    pattern: '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$',
    description: 'Exact case-insensitive login; supply this or github_account_id, exclusively.',
  })
  @ValidateIf((_o, value) => value !== undefined)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/)
  github_account?: string
  @ApiPropertyOptional({
    type: String,
    pattern: '^[1-9][0-9]{0,15}$',
    example: '20',
    description: 'Stable GitHub account ID as a decimal string; mutually exclusive with github_account.',
  })
  @ValidateIf((_o, value) => value !== undefined)
  @Matches(/^[1-9][0-9]{0,15}$/)
  github_account_id?: string
}
@ApiSchema({ name: 'AdminCiConnectionCreate' })
export class CiAdminCreate {
  @ApiProperty({ enum: ['User', 'Organization'] })
  @IsIn(['User', 'Organization'])
  account_type: 'User' | 'Organization'
  @ApiProperty({ pattern: '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$', example: 'alice' })
  @Matches(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/)
  github_account: string
  @ApiProperty({ description: 'Explicitly allow installed private repositories; public repositories remain eligible.' })
  @IsBoolean()
  allow_private_repositories: boolean
  @ApiPropertyOptional({
    type: Boolean,
    default: false,
    example: true,
    description: 'Permit replacement only with both observed expected_binding_id and expected_generation.',
  })
  @IsBoolean()
  force = false
  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    description: 'Required with force:true; omit for ordinary creation.',
  })
  @ValidateIf((_o, value) => value !== undefined)
  @IsUUID()
  expected_binding_id?: string
  @ApiPropertyOptional({
    type: String,
    pattern: '^[1-9][0-9]{0,17}$',
    example: '1',
    description: 'Observed generation, required with force:true; omit for ordinary creation.',
  })
  @ValidateIf((_o, value) => value !== undefined)
  @Matches(/^[1-9][0-9]{0,17}$/)
  expected_generation?: string
}
@ApiSchema({ name: 'AdminCiConnectionVersion' })
export class CiAdminVersion {
  @ApiProperty({
    type: String,
    pattern: '^[1-9][0-9]{0,17}$',
    example: '1',
    description: 'Caller-observed binding generation; a mismatch returns 409 without mutation.',
  })
  @Matches(/^[1-9][0-9]{0,17}$/)
  expected_generation: string
}
@ApiSchema({ name: 'AdminCiConnectionUpdate' })
export class CiAdminUpdate extends CiAdminVersion {
  @ApiProperty()
  @IsBoolean()
  allow_private_repositories: boolean
}

@ApiSchema({ name: 'AdminCiConnection' })
export class CiAdminConnection {
  @ApiProperty({ format: 'uuid' })
  binding_id: string
  @ApiProperty({ format: 'uuid' })
  organization_id: string
  @ApiProperty()
  organization_name: string
  @ApiProperty()
  app_client_id: string
  @ApiProperty({ type: String, pattern: '^[1-9][0-9]*$', example: '10' })
  installation_id: string
  @ApiProperty({ type: String, pattern: '^[1-9][0-9]*$', example: '20' })
  github_account_id: string
  @ApiProperty()
  github_account: string
  @ApiProperty({ enum: ['User', 'Organization'] })
  account_type: 'User' | 'Organization'
  @ApiProperty({ enum: ['provisioning', 'ready', 'disabled', 'failed'] })
  listener_status: string
  @ApiProperty()
  admin_managed: boolean
  @ApiProperty()
  allow_private_repositories: boolean
  @ApiProperty({ type: String, pattern: '^[1-9][0-9]*$', example: '1' })
  generation: string
}
@ApiSchema({ name: 'AdminCiConnectionPage' })
export class CiAdminConnectionPage {
  @ApiProperty({ type: [CiAdminConnection] })
  items: CiAdminConnection[]
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  next_cursor: string | null
}
@ApiSchema({ name: 'AdminCiConnectionError' })
export class CiAdminConnectionError {
  @ApiProperty()
  path: string
  @ApiProperty({ format: 'date-time' })
  timestamp: string
  @ApiProperty({ type: 'integer' })
  statusCode: number
  @ApiProperty()
  error: string
  @ApiProperty()
  message: string
  @ApiPropertyOptional({ type: CiAdminConnection })
  connection?: CiAdminConnection
  @ApiPropertyOptional({ type: [CiAdminConnection], maxItems: 2 })
  connections?: CiAdminConnection[]
}
