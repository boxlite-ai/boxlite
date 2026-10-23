/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Equals, IsRFC3339, IsEmail, IsString, ValidateIf } from 'class-validator'
import { OrganizationMemberRole } from '../../organization/enums/organization-member-role.enum'

/** Body of POST /v1/organizations/invites; see openapi/admin.openapi.yaml. */
export class CreateInvitationDto {
  @IsEmail()
  email: string

  @Equals(OrganizationMemberRole.OWNER)
  role: OrganizationMemberRole.OWNER

  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @IsRFC3339()
  expires_at?: string
}
